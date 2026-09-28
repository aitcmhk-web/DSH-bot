#!/usr/bin/env node
/**
 * summarizer — 从 DSH 会话日志事件流生成"逐事件归纳摘要"。
 *
 * 设计（对齐 workspace-memory 约定）：
 *   1. 过滤层   ：丢弃无效语句/系统噪音，只留用户·助手·关键工具事件。
 *   2. 提取层   ：把每个被保留事件压成一行骨架文本（谁做了什么/说了什么/结果如何）。
 *   3. 渲染层   ：按时间摊平成分点纪要，连同会话元信息一起排版。
 *
 * 无效语句（过滤规则，按类别）：
 *   - 系统注入（source.kind==='plugin'，如 runtime context / sandbox 快照）
 *   - 纯语气词 / 无意义短句（"哈喽""嗨""在吗""嗯"…）
 *   - 纯重复/回显（历史上已出现过完全相同的文本）
 *   - 思维链（assistant message 里 type==='reasoning' 的块）
 *   - 工具结果里的原始长输出（只留"执行了 X，返回 N 字符"，不塞进纪要）
 *   - 结构噪音事件（step/start、step/end、turn/start、turn/end 等纯状态流）
 *
 * 模块化：import { summarizeEvents } from './summarizer.mjs'
 */
import { chatIdFromSession } from './dsh-log-reader.mjs';

//--- 无效文本过滤 ──────────────────────────────────────────

/** 纯语气词/打招呼/无意义短句（去空白、去标点后判断）。 */
const FILLER_SET = new Set([
  '哈喽','嗨','嗨嗨','你好','hello','hi','在吗','在不在','喂','嗯','恩',
  '好','好的','ok','okay','收到','知道了','嗯嗯','哦','哦哦','啊','呃',
  '测试','测试一下','自启','自启成功','没错','对','对的对的','行','可以'
]);
/** 精确匹配的超短无实义词：不用前缀匹配，避免"行车""了解"这类误杀。 */
const SHORT_FILLER_SET = new Set([
  '嗯', '恩', '哦', '啊', '哈', '嗨', '好', '行', '是', '对', '的', '了',
  '嗯嗯', '恩恩', '哦哦', '啊啊', '哈哈', '嗨嗨', '好吧', '好的', '行了',
  '是的', '对的', '了解', '明白', '可以', '没问题'
]);
/** 正则命中的（含语气词/寒暄）剔除。 */
const FILLER_RE = /^(哈喽+|嗨+|你好|hello+|hi+[！!~～吗？?、。]*|在吗[？?]?|喂+[？?]?|嗯+[。！]?|恩+[。！]?|好+吧?|好的*[，。！~]?|ok+[了]?|收到|知道了|没错|对+了*|[哦啊呃]+)$/i;

/** 去掉全部空白和常见标点后保留的可见字符。 */
function squish(s) {
  return (s || '').replace(/[\s\u3000，。！？、：；（）()【】\[\]「」"'`,.、!?~—\-–·…]/g, '');
}

/**
 * 给用户文本分类：keep 还是 drop，以及原因。
 * reason ∈ empty | system-injection | filler | duplicate
 * 说明：keep 时才写入 seenSet，避免把无效句当"已出现"污染去重。
 */
export function classifyUserText(text, seenSet = null) {
  const t = (text || '').trim();
  if (!t) return { action: 'drop', reason: 'empty' };
  // 兜底：系统注入标记开头
  if (/^<system-reminder>/.test(t) || /^<instructions>/.test(t)) {
    return { action: 'drop', reason: 'system-injection' };
  }
  const key = squish(t).toLowerCase();
  if (!key) return { action: 'drop', reason: 'empty' };
  if (FILLER_SET.has(key) || SHORT_FILLER_SET.has(key) || FILLER_RE.test(key)) {
    return { action: 'drop', reason: 'filler' };
  }
  if (seenSet && seenSet.has(key)) return { action: 'drop', reason: 'duplicate' };
  if (seenSet) seenSet.add(key);
  return { action: 'keep', reason: null };
}

/** 纯语气过滤：命中语气词表或寒暄正则则视为无效（兼容旧签名）。 */
export function isFillerText(text, seenSet = null) {
  return classifyUserText(text, seenSet).action === 'drop';
}

/** 提取一条 user/message 的正文文本 —— 白名单：只有 source.kind==='user' 才是用户真话。 */
export function extractUserText(event) {
  const src = event.data?.source;
  // 系统注入（plugin / skill-catalog / agent-instructions / tool 等）一律非用户真话
  if (typeof src !== 'object' || src === null || src.kind !== 'user') return null;
  const content = event.data?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) return null;
  // 系统注入不再在这里提前丢弃：交给 classifyUserText 判定，好让过滤原因可追溯
  return text;
}

/** 提取一条 assistant/message 的正文（跳 reasoning）。 */
export function extractAssistantText(event) {
  const content = event.data?.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text || null;
}

/** 提取 tool 名称 + 精简后的命令参数。 */
export function extractToolCall(event) {
  const d = event.data || {};
  const name = d.name || '?';
  let argsTxt = '';
  if (d.arguments) {
    try {
      const parsed = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments;
      argsTxt = (parsed && (parsed.command || parsed.expression || parsed.url || parsed.query || parsed.pattern || '')) || '';
    } catch {
      argsTxt = typeof d.arguments === 'string' ? d.arguments : '';
    }
  }
  if (name === 'bash') {
    return argsTxt ? `\`bash\`: ${compact(argsTxt, 140)}` : '`bash`';
  }
  return argsTxt ? `\`${name}\` ${compact(argsTxt, 100)}` : `\`${name}\``;
}

/** 工具结果：只留摘要级的一行说明，不展开长输出。 */
export function summarizeToolResult(event) {
  const d = event.data || {};
  const content = d.message?.content;
  let len = 0;
  let isError = d.message?.isError ?? false;
  if (Array.isArray(content)) {
    let s = '';
    const walk = (nodes) => {
      for (const n of nodes) {
        if (!n || typeof n !== 'object') continue;
        if (n.type === 'text' && typeof n.text === 'string') s += n.text;
        else if (Array.isArray(n.content)) walk(n.content);
      }
    };
    walk(content);
    len = s.length;
  }
  if (isError) return '⚠️ 工具报错';
  if (len === 0) return null;
  return `(结果 ${len} 字符)`;
}

/** 单行工具参数/文本压缩。 */
function compact(s, n) {
  const flat = (s || '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

//--- 主归纳 ────────────────────────────────────────────────

/**
 * 把一段事件流归纳成分点纪要。
 * @param {Array<object>} events - DSH 会话事件（已含 session 头）。
 * @param {object} [opts]
 * @param {boolean} [opts.explain] - 追加"过滤明细"小节，列出被判无效的语句与原因。
 * @returns {string} markdown 纪要文本。
 */
export function summarizeEvents(events, opts = {}) {
  const explain = !!opts.explain;
  // 会话元信息
  const head = events.find((e) => e.type === 'session') || {};
  const sessionId = head.id || '';
  const chatId = chatIdFromSession(sessionId) || '';
  const createdAt = head.createdAt || Date.now();

  // 标题（来自 session/title，回退到会话 id 短码）
  const titleEvent = events.find((e) => e.type === 'session/title');
  const title = titleEvent?.data?.title || sessionId;

  // 按 turn 分组产出对话轴；同时记录工具清单与统计
  const memo = [];
  const seenText = new Set();   // 回显去重（只记 keep 的文本）
  const toolNames = new Set();
  const stats = { userMsgs: 0, asstMsgs: 0, tools: 0, filtered: 0, suppressed: 0, turns: 0 };
  const turns = new Set();
  const filteredLog = [];

  // 先把 user/assistant 文本与工具调用按 seq 摊开
  const sequence = events
    .filter((e) => ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(e.type))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  const note = (ev, reason, preview) => {
    if (explain) filteredLog.push({ seq: ev.seq ?? 0, type: ev.type, reason, preview: compact(preview || '', 60) });
  };

  let pendingTool = null; // 最近一次 tool/call，用于把 result 并入
  // 用户整轮无效（纯语气/重复）时，抑制本轮后续的 assistant/tool 输出
  let suppressTurn = false;

  for (const ev of sequence) {
    const seq = ev.seq ?? 0;
    switch (ev.type) {
      case 'user/message': {
        const srcKind = ev.data?.source?.kind ?? null;
        const text = extractUserText(ev);
        // 白名单：只有 source.kind==='user' 才是用户真话；其余都是系统注入
        if (srcKind !== 'user') { stats.filtered++; note(ev, 'system-injection', text || srcKind); continue; }
        if (!text) { stats.filtered++; note(ev, 'empty', ''); continue; }
        const cls = classifyUserText(text, seenText);
        if (cls.action === 'drop') {
          stats.filtered++;
          note(ev, cls.reason, text);
          // 纯语气/重复 → 整轮无信息量，抑制后续输出；系统注入不影响本轮
          if (cls.reason === 'filler' || cls.reason === 'duplicate') suppressTurn = true;
          continue;
        }
        suppressTurn = false;
        stats.userMsgs++;
        memo.push({ seq, tag: 'user', text: compact(text, 240) });
        break;
      }
      case 'assistant/message': {
        if (suppressTurn) { stats.suppressed++; note(ev, 'filler-turn', extractAssistantText(ev) || ''); break; }
        const text = extractAssistantText(ev);
        if (text) {
          stats.asstMsgs++;
          if (ev.data?.turn != null) turns.add(ev.data.turn);
          memo.push({ seq, tag: 'asst', text: compact(text, 220) });
        }
        break;
      }
      case 'tool/call': {
        if (suppressTurn) { stats.suppressed++; note(ev, 'filler-turn', ev.data?.name || ''); break; }
        const line = extractToolCall(ev);
        toolNames.add((ev.data?.name) || '?');
        stats.tools++;
        if (ev.data?.turn != null) turns.add(ev.data.turn);
        pendingTool = line;
        memo.push({ seq, tag: 'tool', text: line });
        break;
      }
      case 'tool/result': {
        if (suppressTurn) break;
        const res = summarizeToolResult(ev);
        // 挂在最近的 tool 行后面
        if (pendingTool && res) {
          const last = memo[memo.length - 1];
          if (last && last.tag === 'tool') last.text = `${last.text} ${res}`;
        }
        pendingTool = null;
        break;
      }
    }
  }
  stats.turns = turns.size;

  // 渲染
  let out = `# 会话纪要：${compact(title, 60)}\n\n`;
  out += `- **会话**：\`${sessionId}\`\n`;
  out += `- **chat**：${chatId || '—'}\n`;
  out += `- **时间**：${new Date(createdAt).toLocaleString('zh-CN', { hour12: false })}\n`;
  out += `- **统计**：${stats.turns} 轮 / ${stats.userMsgs} 条用户 / ${stats.asstMsgs} 条回复 / ${stats.tools} 次工具调用`
    + `（过滤 ${stats.filtered} 条无效${stats.suppressed ? `，整轮抑制 ${stats.suppressed} 条` : ''}）\n`;
  if (toolNames.size) out += `- **涉及命令**：\`${[...toolNames].join('`, `')}\`\n`;
  out += `\n`;

  if (memo.length === 0) {
    out += `_本轮没有可归纳的有效对话。_\n`;
  } else {
    out += `## 事件纪要\n\n`;
    for (const m of memo) {
      const prefix = m.tag === 'user' ? '`👤`' : m.tag === 'asst' ? '`🤖`' : '`🔧`';
      out += `- ${prefix} ${m.text}\n`;
      out += `\n`; // 空行分隔，避免 markdown 连续列表粘连
    }
  }

  if (explain && filteredLog.length) {
    out += `\n## 过滤明细（--explain）\n\n`;
    for (const f of filteredLog) {
      out += `- seq ${f.seq} · ${f.type} · \`${f.reason}\` · ${f.preview}\n`;
    }
  }

  return out.trimEnd();
}

//--- CLI ────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1].endsWith('summarizer.mjs');
if (isMain) {
  const { readSessionEvents } = await import('./dsh-log-reader.mjs');
  const args = process.argv.slice(2);
  const explain = args.includes('--explain');
  const sid = args.find((a) => !a.startsWith('--'));
  if (!sid) { console.error('用法: node summarizer.mjs <sessionId> [--explain]'); process.exit(1); }
  const { ok, events, error } = readSessionEvents(sid);
  if (!ok) { console.error('❌', error); process.exit(1); }
  process.stdout.write(summarizeEvents(events, { explain }));
}
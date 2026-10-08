/**
 * hard-rules v2 — 最高指令常驻提醒 **+ 失败特征触发教训注入**。
 *
 * 基础功能（v1，别动）：
 *   用户 2026-10-02 定：不是「会话开头读过一次就算」，而是「每动若干次手就再出现一次」，
 *   否则干着干着就忘了。
 *
 * 新增功能（v2，用户 2026-10-03 定）：
 *   教训是「要用才去查」，而我**不一定想得起来查** —— 光靠自觉靠不住，得由机制兜住。
 *   所以命中已知失败特征时，把这个特征对应的那几条教训**自动顶进上下文**。
 *   用户原话：「微信遇到 -2，自动调用 hook 注入原因，就不会去反复查原因」。
 *   ⚠️ 注入的是**提示不是结论**（`-2` 可瞬态可终局，仍要探活区分）—— 文案里必须写明这一点。
 *
 * 机制（两个挂载点，都是 waterfall）：
 *   ① `agent/pre-step`（dsh-agent-loop/lib/index.js:911）→ **最高指令**。
 *      监听者签名 `(payload, next)`；payload 带 `messages`（本步要发给模型的消息）。
 *      返回 `{ kind: 'enter', messages: [...payload 原样, 规则] }` 后，loop 会把 messages
 *      逐条 append 成 `user/message`（同文件 1061 行）—— 所以规则在模型**决定第一次动手之前**
 *      就进了上下文（v1 挂在 post-execute 上，是**工具跑完之后**才注入，卡不住第一次动手）。
 *   ② `tools/post-execute`（dsh-tools/lib/index.js:3504）→ **教训钩子**。
 *      监听者签名是 `(exec, result, next)` —— **工具结果 result 会被传进来**，所以能扫它的文本。
 *      返回 `{ kind: 'accept', additionalContexts: [message] }` 后，这些 context 会被原样
 *      splice 进 loop 的 next-step inbox（dsh-agent-loop/lib/index.js:572 `acceptContext`，
 *      **不做任何形状校验**），于是它作为一条独立消息出现在下一次模型请求里。
 *
 * ⚠️ 刻意**不** import 任何 `@deepseek-ai/*` 内部包：plugin 要能被独立装/卸，
 *    多一个内部依赖多一处装不上的风险。这里手搓同形状的 user message 即可。
 * ⚠️ 规则文件在插件 load 时读一次并缓存 —— 改**规则**内容要重启才生效。
 *    （教训档是**命中时现读**的，改教训档不用重启。）
 * ⚠️ 只挂「动手」类工具；read / grep / glob 之类不挂，省 token。
 *
 * 这个文件被两份 profile patch 引用（`~/.dsh/profiles/{desktop,bot}/cordis.patch.yml`），
 * 用 `file://` 绝对路径 insert；两边的规则文件是同一份。
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/** Cordis 插件名。 */
export const name = 'hard-rules';

/** 默认规则文件（用户手写「最高指令」的地方）。 */
const DEFAULT_RULES_PATH = '/Users/tcm/DSH/BOT/HARD-RULES.md';

/** 挂了哪些工具 —— 只挂动手的。 */
const DEFAULT_TOOLS = ['bash', 'edit', 'write', 'str-replace', 'str_replace'];

/**
 * 注入计数日志（实测用，用户 2026-10-02 要数注入次数）。
 * 每注入一次追加一行；重启后数行数即可。
 * 格式：常规提醒 `<ISO>\t<工具名>`；特征触发 `<ISO>\tsig:<特征 id>\t<工具名>`。
 * ⛔ 只写计数，不写规则/教训内容。
 */
const DEFAULT_HIT_LOG = '/tmp/hard-rules-hits.log';

/**
 * 最高指令每多少**步**注入一次（用户 2026-10-02 定：每次调用都注入太频繁，
 * 一次任务动 20 次手会堆 20 份规则 ≈ 6000 token；2026-10-03 改挂 `agent/pre-step`，
 * 计数单位随之从「工具次数」变成「模型步数」）。
 * 计数规则：**第 1 步就注入**（开工先看到规则），之后每 N 步再来一次（1, N+1, 2N+1…）。
 * ⚠️ 口径必须与 `DSH/BOT/src/index.js`（插件里那份）保持一致。
 */
const DEFAULT_EVERY_N = 10;

/** 单条教训注入的正文上限（字符），超了截断 —— 防 token 爆炸。 */
const LESSON_CAP = 1000;

/** 一次注入里所有教训条目的总上限（字符）。 */
const TOTAL_CAP = 2000;

/** 扫结果文本的上限（字符）—— 大日志只扫开头，够抓特征。 */
const SCAN_CAP = 20000;

/**
 * 教训档里一条教训的取法：`## 第 N 条 ...` 到下一个 `## 第 M 条` 之间。
 * 找不到就返回空串（不抛）。
 * @param {string} md
 * @param {number} n
 * @returns {string}
 */
function lessonBody(md, n) {
  const head = new RegExp(`^## 第 ${n} 条[^\\n]*\\n`, 'm').exec(md);
  if (!head) return '';
  const start = head.index + head[0].length;
  const rest = md.slice(start);
  const next = /^## 第 \d+ 条/m.exec(rest);
  let body = (next ? rest.slice(0, next.index) : rest).trim();
  if (body.length > LESSON_CAP) {
    const cut = body.slice(0, LESSON_CAP);
    body = `${cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : LESSON_CAP)}\n…（截断，全文见 lessons-bot.md 第 ${n} 条）`;
  }
  return body;
}

/**
 * 多条目合并后的总长度闸：超了就在行边界截断，并留一句指路。
 * @param {string} joined
 * @param {number[]} numbers
 * @returns {string}
 */
function trimTotal(joined, numbers) {
  if (joined.length <= TOTAL_CAP) return joined;
  const cut = joined.slice(0, TOTAL_CAP);
  const nl = cut.lastIndexOf('\n');
  return `${cut.slice(0, nl > 0 ? nl : TOTAL_CAP)}\n…（已截断，全文见 lessons-bot.md 第 ${numbers.join('、')} 条）`;
}

/**
 * 结果文本提取：tool result 的 content 是 block 数组。
 * @param {any} result
 * @returns {string}
 */
function resultText(result) {
  const parts = [];
  const content = result?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block?.text === 'string') parts.push(block.text);
    }
  } else if (typeof content === 'string') {
    parts.push(content);
  }
  if (typeof result?.error === 'string') parts.push(result.error);
  if (typeof result?.value === 'string') parts.push(result.value);
  return parts.join('\n').slice(0, SCAN_CAP);
}

/** 从 bash 命令里取「第一条真正干活的子命令」（跳过 `cd xxx &&`）。 */
function primaryCmd(command) {
  const segs = String(command ?? '')
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return segs.find((s) => !/^cd\s/.test(s)) ?? '';
}

/**
 * 命令是不是「读 / 搜」类。
 * ⛔ 必须有这道闸：我去 `grep ret=-2 memory/lessons-bot.md` 时，**输出里就带着 `ret=-2`**，
 *    没有这道闸就会自己把自己骗一遍（用户 2026-10-03 特别强调「注入条件要准确」）。
 */
const READONLY_CMD = /^(grep|rg|sed|awk|cat|head|tail|less|more|find|ls|wc|md5|md5sum|shasum|diff|plutil)\b/;

/**
 * 输出特征规则（只扫 bash 的结果文本）。
 * lessons = `memory/lessons-bot.md` 里的条号（本文件 第 N 条 ↔ 教训档 第 N 条）。
 */
const RESULT_RULES = [
  {
    id: 'wx-ret-neg2',
    label: '微信 ret=-2',
    test: (t) =>
      /["']?ret["']?\s*[:=]\s*-2\b/.test(t) &&
      /errmsg|errcode|message_id|session|sendText|wx/i.test(t),
    lessons: [15, 16],
    hint: '⛔ 不能由一次 ret=-2 反推通道死了（可瞬态可终局）—— 先用 getUpdates 探活区分，再看同一时段 TG 侧有没有同款报错；⛔ 不许回退到「上次的 token」（陈旧 token 自己会把 -2 撞出来）。',
  },
  {
    id: 'wx-fake-ok',
    label: '微信 ret:0 假成功',
    test: (t) => {
      const m = /["']?ret["']?\s*[:=]\s*0\b/.exec(t);
      if (!m) return false;
      if (!/errmsg|wx|weixin|session|sendText/i.test(t)) return false;
      return !/message_id/.test(t.slice(m.index, m.index + 400));
    },
    lessons: [16],
    hint: 'ret:0 **不算成功** —— 唯一成功信号是返回里带 message_id；没有 message_id = 消息被丢弃（假成功）。',
  },
  {
    id: 'wx-session-timeout',
    label: 'errcode:-14 会话超时',
    test: (t) => /["']?errcode["']?\s*[:=]\s*-14\b/.test(t),
    lessons: [16, 17],
    hint: '凭据会话在服务端已超时 → 只能本机重新扫码；⛔ 扫码前先确认真凶方向，别让用户反复扫。',
  },
  {
    id: 'tg-409',
    label: '409 Conflict',
    test: (t) => /\b409\b/.test(t) && /conflict/i.test(t),
    lessons: [8],
    hint: '一个 token 只能有一个进程 —— 先找另一个进程，别急着换 token。',
  },
  {
    id: 'fetch-failed',
    label: 'fetch failed',
    test: (t) => /\bfetch failed\b/i.test(t),
    lessons: [15],
    hint: 'fetch failed 是**本机网络/DNS** 错误 —— 判据是看同一时段 TG 侧有没有同款报错；有 → 网络问题，⛔ 别动端点代码。',
  },
];

/** 入参特征规则（扫工具入参，主要是 bash 的 command）。 */
const COMMAND_RULES = [
  {
    id: 'suicide',
    label: './bot.sh stop|restart',
    test: (c) => /\bbot\.sh\s+(stop|restart)\b/.test(c),
    lessons: [8],
    hint: '⛔ 自杀禁令：在 bot 自己的会话里跑 stop / restart 会把自己杀掉 —— 换 Telegram 菜单 `/restart`，或双击 `重启.command`。',
  },
  {
    id: 'force-push',
    label: 'git push --force',
    test: (c) => /git\s+push\b[^\n|;&]*(\s-f\b|--force)/.test(c),
    lessons: [8],
    hint: '⛔ 危险操作：动手前一句话说清「改什么、可不可逆」。',
  },
  {
    id: 'rm-rf',
    label: 'rm -rf',
    test: (c) => /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)/.test(c),
    lessons: [8],
    hint: '删除不可逆 —— 先确认解析出来的**绝对路径**就是你要删的那个。',
  },
  {
    id: 'cordis-patch',
    label: '改 cordis.patch.yml',
    test: (c, tool) =>
      /cordis\.patch\.yml/.test(c) && (tool === 'edit' || tool === 'write' || tool === 'str-replace' || tool === 'str_replace'),
    lessons: [7, 8],
    hint: '⛔ 改 `cordis.patch.yml` 必须「先写临时文件 → `mv` 原子替换」（运行中 HMR 会热重载，原地编辑的中间态会让插件树崩）；改完跑解析验证 + `diff 备份 当前` 复核。',
  },
  {
    id: 'wx-qr',
    label: '微信扫码 / 二维码',
    test: (c) => /weixin-login|--url-only|qrcode|二维码/.test(c),
    lessons: [17],
    hint: '⛔ 别再让用户反复扫码 —— 扫码前先确认真凶方向；二维码只出现在**执行命令的那个终端**。',
  },
];

/**
 * 重复劳动（第 11 条）：同一条「查账类」命令第二次跑 = 很可能在重推已查清的结论。
 * 只认 grep / rg / sed / find / curl / dsh 这类查证命令，避免 `ls` 之类误报；
 * 每条命令只在**本进程内**提示一次。
 */
const DUP_KEYWORDS = /\b(grep|rg|sed|find|curl|dsh|plutil)\b/;
const DUP_MIN_LEN = 24;

/**
 * 读规则文件。读不到返回空串（不抛）—— 宁可没有提醒，也不能让 profile 起不来。
 * @param {string} path
 * @returns {string}
 */
function loadRules(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{path?:string, lessonsPath?:string, tools?:string[], everyN?:number, hitLog?:string, triggers?:boolean}} [config]
 */
export function apply(ctx, config = {}) {
  const rulesPath = config.path ?? DEFAULT_RULES_PATH;
  const tools = new Set(config.tools ?? DEFAULT_TOOLS);
  const text = loadRules(rulesPath);

  // ── 来源闸（source-guard）：实现在同目录 source-guard.mjs —— 一处改，所有引用本文件的 profile 共用 ──
  //    ⚠️ 动态 import + 兜底：source-guard 出问题不许连累最高指令注入。
  import('./source-guard.mjs')
    .then((m) => m.apply(ctx, config.sourceGuard ?? {}))
    .catch((err) => console.error(`[hard-rules] source-guard 未挂载: ${err?.message ?? err}`));

  if (text.length === 0) {
    console.error(`[hard-rules] 规则文件为空或读不到，跳过挂载：${rulesPath}`);
    return;
  }

  // 教训档：默认跟在规则文件同一个工作区里（不用改 profile patch 就能生效）。
  const lessonsPath = config.lessonsPath ?? join(dirname(rulesPath), 'memory', 'lessons-bot.md');
  const triggersOn = config.triggers !== false;

  const hitLog = config.hitLog ?? DEFAULT_HIT_LOG;
  const everyN = Math.max(1, Number(config.everyN ?? DEFAULT_EVERY_N) || DEFAULT_EVERY_N);
  /** 步数计数（进程级，同一插件的两次挂载共用）—— 最高指令的节奏按「步」算。 */
  let steps = 0;
  /** ⚠️ 同一个 `agent/pre-step` 事件会被 ctx 与 ctx.root 两个挂载**各触发一次** ——
   *  这里按 payload 对象身份去重，保证「一步只计 1、只注 1」。
   *  （旧版按 exec 身份对 `tools/post-execute` 去重，2026-10-02 实测过不去重会变成每 5 次一注。） */
  let lastRulesPayload = null;
  /** 已经塞过规则的那一步的 payload（同一步的第二次挂载只放行，不重复注入）。 */
  let injectedRulesPayload = null;
  /** 已触发过的特征 id（进程内只注入一次，不刷屏）。 */
  const firedSignatures = new Set();
  /** 已跑过的查账类命令（`归一化命令` → 次数）。 */
  const seenCommands = new Map();

  /** 追加计数行；记不上账不影响注入本身。 */
  const count = (line) => {
    try {
      appendFileSync(hitLog, `${new Date().toISOString()}\t${line}\n`);
    } catch {
      // ignore
    }
  };

  /** 手搓一条 user message（形状与上游一致，⛔ 不 import 内部包）。 */
  const contextMessage = (body, kind) => ({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: body }],
    source: { kind },
  });

  /** `tools/post-execute`（教训钩子）的返回形状：认 `additionalContexts`。 */
  const message = (body, kind) => ({
    kind: 'accept',
    additionalContexts: [contextMessage(body, kind)],
  });

  /** 拼注入正文：头部说明 + 提示 + 教训原文（教训档读不到就只给提示）。 */
  const renderLesson = (rule) => {
    const md = rule.lessons.length > 0 ? loadRules(lessonsPath) : '';
    const bodies = [];
    for (const n of rule.lessons) {
      if (md.length === 0) break;
      const body = lessonBody(md, n);
      if (body) bodies.push(`── 教训档 第 ${n} 条 ──\n${body}`);
    }
    const tail = bodies.length > 0
      ? `\n\n${trimTotal(bodies.join('\n\n'), rule.lessons)}`
      : (rule.lessons.length > 0
        ? `\n\n（教训档读不到：${lessonsPath} —— 请自己去看 第 ${rule.lessons.join('、')} 条）`
        : '');
    return [
      `【教训钩子 · 命中特征「${rule.label}」】`,
      rule.hint,
      '',
      '⚠️ 这是**提示不是结论** —— 别拿它当已验证，要下结论仍须当场贴出命令 + 输出。',
      tail,
    ].join('\n');
  };

  /** 教训钩子：挂在 `tools/post-execute`，必须拿到工具结果才能扫特征。 */
  const handler = (exec, result, next) => {
    const toolName = String(exec?.name ?? '');
    if (!tools.has(toolName)) return next();

    if (triggersOn) {
      const isBash = toolName === 'bash';
      const command = isBash ? String(exec?.arguments?.command ?? exec?.arguments?.cmd ?? '') : '';

      // ① 输出特征（只扫 bash，且命令本身不是「读/搜」类 —— 否则会自我欺骗）
      if (isBash && !READONLY_CMD.test(primaryCmd(command))) {
        const body = resultText(result);
        if (body.length > 0) {
          for (const rule of RESULT_RULES) {
            if (firedSignatures.has(rule.id)) continue;
            if (!rule.test(body)) continue;
            firedSignatures.add(rule.id);
            count(`sig:${rule.id}\t${toolName}`);
            return message(renderLesson(rule), 'lesson-hook');
          }
        }
      }

      // ② 入参特征
      const haystack = isBash ? command : JSON.stringify(exec?.arguments ?? '');
      for (const rule of COMMAND_RULES) {
        if (firedSignatures.has(rule.id)) continue;
        if (!rule.test(haystack, toolName)) continue;
        firedSignatures.add(rule.id);
        count(`sig:${rule.id}\t${toolName}`);
        return message(renderLesson(rule), 'lesson-hook');
      }

      // ③ 重复劳动
      if (isBash && command.length >= DUP_MIN_LEN && DUP_KEYWORDS.test(command)) {
        const key = command.replace(/\s+/g, ' ').trim();
        const times = (seenCommands.get(key) ?? 0) + 1;
        seenCommands.set(key, times);
        if (times === 2 && !firedSignatures.has('dup-command')) {
          firedSignatures.add('dup-command');
          count(`sig:dup-command\t${toolName}`);
          return message(renderLesson({
            id: 'dup-command',
            label: '同一条查账命令又跑了一遍',
            lessons: [11],
            hint: '⛔ 重复劳动禁令：动手推结论前先查账（`grep -n "<关键词>" memory/lessons-bot.md` + `grep -rn ... --include=*.mjs --include=*.js --include=*.yml .`）；上一轮的结论大量藏在**文件头注释**里 —— ⛔ 不许因为「这次角度不同」就重查一遍。',
          }), 'lesson-hook');
        }
      }
    }

    // 常规规则提醒已移到 `agent/pre-step`（动手之前注入），这里只留教训钩子。
    return next();
  };

  /**
   * 最高指令：挂在 `agent/pre-step` —— 每一步模型请求**之前**触发，
   * 所以第 1 步就注入 = 模型决定第一次动手之前就看到了规则（这是本次改动的全部目的）。
   * 节奏：第 1 步注入，之后每 everyN 步一次（1, N+1, 2N+1…）。
   * ⚠️ payload 的 messages 必须**原样保留**，我们只在末尾追加一条；丢了它 = 用户消息不见了。
   */
  const rulesHandler = (payload, next) => {
    if (payload !== lastRulesPayload) {
      lastRulesPayload = payload;
      steps += 1;
    }
    // 同一步的第二次挂载：放行（外层拿到原始决策后再追加，保证只追加一次）。
    if (injectedRulesPayload === payload) return next();
    if (steps % everyN !== 1) return next();
    injectedRulesPayload = payload;
    count('pre-step');
    return Promise.resolve(next()).then((decision) => {
      if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
      return { ...decision, messages: [...decision.messages, contextMessage(text, 'hard-rules')] };
    });
  };

  // ⚠️ 两个事件都挂两份（ctx + ctx.root）—— 它们都是 agent 作用域事件，
  //    根 ctx 通常收得到，但被挂到不相关 scope 下就会漏（同 approval-bridge 的做法）。
  //    waterfall 在第一个返回决定值的监听者处终止；同一步 / 同一次调用的重复挂载用对象身份去重。
  const targets = ctx.root && ctx.root !== ctx ? [ctx, ctx.root] : [ctx];
  let mounted = 0;
  for (const target of targets) {
    if (typeof target?.on !== 'function') continue;
    try {
      target.on('agent/pre-step', rulesHandler);
      target.on('tools/post-execute', handler);
      mounted += 1;
    } catch (err) {
      console.error(`[hard-rules] 挂载失败: ${err?.message ?? err}`);
    }
  }
  console.error(`[hard-rules] 已挂载（${mounted} 处 / ${text.length} 字）：${rulesPath}｜最高指令 第 1 步 + 每 ${everyN} 步｜教训钩子 ${triggersOn ? `开（${lessonsPath}）` : '关'}`);
}

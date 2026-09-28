/**
 * Telegram 客户端 —— 从 BOT/telegram.js 搬运而来，**只改必要的部分**。
 *
 * ⭐ 搬运原则：这个文件里绝大多数是**与业务无关的纯逻辑**
 *   （Markdown→HTML 转、标签感知切分、400 降级重发），那些坑是踩出来的，
 *   **一行都不改** —— 改了就是重新踩一遍。改动逐条列在下面。
 *
 * ⚠️ 与原版的差异（全部是「必须改」，没有一条是「我想改」）：
 *
 *   ① `API_ROOT` 由**构造参数**决定，不再读 `process.env.TELEGRAM_API_ROOT`。
 *      原因：插件是发布的，多个用户各自的 token/环境不该互相污染；
 *      宿主进程的 env 也不该被插件的读法绑架。原来的 env 覆盖留给测试用。
 *
 *   ② `getFileBytes` 的 curl 兜底分支修了两个真 bug：
 *      · 原版用 `require('node:fs')` —— 但这是 ESM 文件，`require` **未定义**，
 *        走到这个分支会抛 `ReferenceError`，而不是它想给的「curl 也失败了」。
 *        也就是说这个兜底路径**从来没真正工作过**。
 *      · 原版用了 `require` 却没 `unlinkSync` 成功后的临时文件 → 会往 /tmp 漏文件。
 *      改成 top-level `import { readFileSync, unlinkSync } from 'node:fs'`，
 *      并且在成功/失败两条路径上都清理临时文件。
 *      ⚠️ 这是**行为修复**，不是等价搬运 —— 原版这条路径是坏的，没法「保持一致」。
 *
 *   ③ `sendMessage` 支持 `extra` 里的 `disable_notification` 等原样透传 —— 原版已支持，
 *      未改，只是记一笔确认过。
 */

// Force direct connection — bypass macOS system proxy / NE routing that may
// resolve api.telegram.org to a mainland-China CDN node (e.g. 183.192.195.196)
// which is unreachable from this host.
import https from 'node:https';
import { readFileSync, unlinkSync } from 'node:fs';

const DEFAULT_API_ROOT = 'https://api.telegram.org';

const DIRECT_AGENT = new https.Agent({
  proxy: undefined,
  keepAlive: true,
});

export class Telegram {
  /**
   * @param {string} token BotFather 给的 token（每个用户自己的）
   * @param {{apiRoot?: string}} [options] apiRoot 仅测试用（指向本地桩服务）
   */
  constructor(token, options = {}) {
    const root = (options.apiRoot ?? DEFAULT_API_ROOT).replace(/\/$/, '');
    this.token = token;
    this.base = `${root}/bot${token}`;
    this.fileBase = `${root}/file/bot${token}`;
  }

  /** Call any Bot API method; throws a descriptive error when `ok` is false. */
  async call(method, payload = {}, options = {}) {
    const response = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: options.signal,
      agent: DIRECT_AGENT,
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`${method}: HTTP ${response.status}`);
    }
    if (!body.ok) {
      const error = new Error(`${method}: ${body.description ?? `HTTP ${response.status}`}`);
      error.errorCode = body.error_code;
      error.description = body.description;
      error.parameters = body.parameters;
      throw error;
    }
    return body.result;
  }

  getMe() {
    return this.call('getMe');
  }

  setMyCommands(commands) {
    return this.call('setMyCommands', { commands });
  }

  getUpdates(offset, timeoutSeconds = 30, signal) {
    return this.call(
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] },
      { signal },
    );
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, ...extra });
  }

  /**
   * 发送带格式的消息：markdown → Telegram HTML。
   *
   * ⚠️ 为什么不能简单地在 sendMessage 上加 parse_mode=HTML：
   * Telegram 遇到**任何**非法 HTML（裸 `<`、未闭合标签）都返回 400。
   * 调用方多为 `try{}catch{}`，一旦 400 就**静默丢消息**——用户以为 bot 死了。
   * 所以这里做三重保险：
   *   1. 转义 + 标签感知切分（每块都是合法 HTML）
   *   2. 逐块 htmlIsBalanced() 自检，不合法直接走纯文本
   *   3. 发送 400 时**自动降级为纯文本重发**，保证消息一定送达
   *
   * @returns {Promise<{ok:boolean, mode:'html'|'plain', chunks:number, fallback?:string}>}
   */
  async sendRich(chatId, markdown, extra = {}) {
    // ⚠️ 2026-09-19 修「回答重复两遍」（原版注释，坑照抄保留）：
    // 旧版逐块发 HTML，catch 里却从 plainParts[0] **整份重发** ——
    // 第 2 块失败时，第 1 块已经发出去了，又被纯文本重发一遍 = 用户看到重复。
    //
    // 修法：切分仍在 HTML 之后做（保证表格转换/转义膨胀都已定型，
    // 且 splitMessageHtml 保证每块标签闭合），但**记录已成功发送的块数**，
    // 降级时只补发「失败的那块及其后」，绝不回头重发。
    const html = markdownToHtml(markdown);
    const parts = splitMessageHtml(html);
    const { parse_mode: _drop, ...cleanExtra } = extra;

    // 保险 2：任何一块标签不配对 → 整体走纯文本（宁可没格式，不可丢消息）
    if (!parts.every((p) => htmlIsBalanced(p))) {
      for (const p of splitMessage(String(markdown ?? ''))) {
        await this.sendMessage(chatId, p, cleanExtra);
      }
      return { ok: true, mode: 'plain', chunks: parts.length };
    }

    for (let i = 0; i < parts.length; i++) {
      try {
        await this.sendMessage(chatId, parts[i], { ...extra, parse_mode: 'HTML' });
      } catch (err) {
        // 保险 3：**只**把第 i 块起降级为纯文本（前 i 块已成功，绝不重发）
        const restPlain = splitMessageHtmlPlain(parts.slice(i));
        for (const p of restPlain) {
          await this.sendMessage(chatId, p, cleanExtra);
        }
        return { ok: true, mode: 'plain', chunks: parts.length, fallback: err.message };
      }
    }
    return { ok: true, mode: 'html', chunks: parts.length };
  }

  answerCallbackQuery(callbackQueryId, extra = {}) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...extra });
  }

  editMessageText(chatId, messageId, text, extra = {}) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra });
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action });
  }

  async getFileBytes(fileId) {
    const file = await this.call('getFile', { file_id: fileId });
    const url = `${this.fileBase}/${file.file_path}`;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (err) {
      // Fallback: use curl (may have better network handling / proxy support)
      console.error(`[tg] fetch download failed for ${fileId}: ${err.message}, trying curl...`);
      const { execFileSync } = await import('node:child_process');
      const tmp = `/tmp/tg-file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`;
      try {
        const code = execFileSync(
          'curl',
          ['-s', '-o', tmp, '-w', '%{http_code}', '--connect-timeout', '15', '-L', url],
          { encoding: 'utf8' },
        ).trim();
        if (code !== '200') throw new Error(`curl download failed: HTTP ${code}`);
        return readFileSync(tmp);
      } finally {
        // 原版漏了成功路径的清理，这里两条路径都清。
        try {
          unlinkSync(tmp);
        } catch {
          /* 文件可能压根没建出来，忽略 */
        }
      }
    }
  }
}

/** Telegram rejects messages over 4096 characters; split on line boundaries. */
export function splitMessage(text, limit = 4000) {
  const source = String(text ?? '');
  if (source.length <= limit) return [source];
  const chunks = [];
  let rest = source;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * 把若干「已转好 HTML 的块」转回纯文本并按长度切开，用于降级发送。
 *
 * ⚠️ 只剥白名单标签、还原三个 HTML 实体，**不做 markdown 反解析**
 * （降级是保送达的兜底路径，格式丢失可接受，绝不能因为反解析出错又抛异常）。
 * ⚠️ 剥离标签后长度只会变短，用 4000 上限切分安全。
 */
export function splitMessageHtmlPlain(htmlChunks, limit = 4000) {
  const plain = htmlChunks
    .join('')
    .replace(/<\/?(?:b|strong|i|em|u|s|code|pre|a|blockquote|tg-spoiler)\b[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return splitMessage(plain, limit);
}

// ---------------------------------------------------------------------------
// HTML 排版支持（原版 2026-09-13 加，坑照抄保留）
//
// 为什么用 HTML 而不是 Markdown/MarkdownV2：MarkdownV2 要求转义
// `_ * [ ] ( ) ~ ` > # + - = | { } . !` 每个符号，agent 的中文回答里满地都是，
// 极易 400。HTML 只需转义 `& < >` 三个字符。
//
// ⚠️ 三条铁律（改这段代码前必读）：
//   1. **先转义，再插标签**。反了会把刚生成的 <b> 又转义成可见的 &lt;b&gt;。
//   2. **切分必须标签感知**。若 <b> 在切口前、</b> 在切口后，两半都非法 → 双 400。
//      所以用 splitMessageHtml() 而不是 splitMessage()。
//   3. **发送失败要能降级**。含裸 `<`/`&` 的文本会让 Telegram 返回 400，
//      调用方若包在 try/catch 里会**静默丢消息**。见 sendRich()。
// ---------------------------------------------------------------------------

/** 转义 Telegram HTML 的三个保留字符（& 必须最先，否则会二次转义）。 */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Telegram 允许的标签白名单（只放行这些，其余一律转义）。 */
const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler',
]);

/**
 * Markdown 表格 → 「键值条目」文本。
 *
 * 输入（表头 + `|---|` 分隔行 + 数据行）：
 *     | 项目 | 状态 | 备注 |
 *     |---|---|---|
 *     | 微信接入 | 正常 | 无任何问题 |
 *
 * 输出：
 *     项目: 微信接入
 *       状态: 正常
 *       备注: 无任何问题
 *
 * 判定为表格的条件（从严，避免误伤正文里的 `|`）：
 *   1. 至少两行连续以 `|` 开头（经 escapeHtml 后仍是 `|`，不受影响）；
 *   2. 其中**存在**一行是分隔行（单元格只含 `-`、`:`、空格）。
 * 没有分隔行就不认，原样返回 —— 这是区分「真表格」和「正文里写了竖线」的关键。
 *
 * ⚠️ 首列做标题行且**不加粗**（用户实测：加粗后字宽变化反而更容易看歪）。
 * ⚠️ 值里若原本有 `**粗体**`/`` `代码` ``，此处不动它，交给外层后续的行内规则处理。
 */
function convertTables(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;

  /** 一行是否为「表格行」：允许前导空格，首尾是 `|`。 */
  const isRow = (line) => /^[ \t]*\|.*\|[ \t]*$/.test(line);
  /** 一行是否为「分隔行」：单元格里只有 - : 和空格，且至少一个 -。 */
  const isSep = (line) =>
    /^[ \t]*\|[ \t:|-]+\|[ \t]*$/.test(line) && /-/.test(line);
  /** 拆单元格：去掉首尾 `|`，按 `|` 切，trim。 */
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  while (i < lines.length) {
    // 找表格起点：本行是表格行，下一行是分隔行 → 认定为一个表格。
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const header = cells(lines[i]);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && isRow(lines[j])) {
        rows.push(cells(lines[j]));
        j++;
      }

      // 每个数据行 → 一个「条目」，条目之间空一行。
      // 形态（用户 2026-09-15 选定）：
      //     ● 条目名          ← `● `(U+25CF 大圆点) 前缀 + 加粗，条目边界一眼可辨
      //     字段: 值          ← 顶格，不缩进（缩进版用户觉得像没对齐）
      // ⚠️ 符号是 `●`(U+25CF) 不是 `•`(U+2022，列表用的那个) 也不是 `▪`(U+25AA)。
      //    用户明确挑的大圆点：既区别于列表圆点，又比方块轻。
      const entries = rows.map((row) => {
        const parts = [];
        row.forEach((value, col) => {
          if (value === '') return; // 空单元格直接跳过，不产生 `列名: ` 噪音
          const name = header[col] ?? '';
          if (col === 0) {
            // 首列 = 条目标题：`● ` 前缀 + 加粗
            parts.push(`<b>● ${name ? `${name}: ${value}` : value}</b>`);
          } else {
            parts.push(name ? `${name}: ${value}` : value);
          }
        });
        return parts.join('\n');
      });

      out.push(entries.filter(Boolean).join('\n\n'));
      i = j;
      continue;
    }
    out.push(lines[i]);
    i++;
  }

  return out.join('\n');
}

/**
 * 极简 Markdown → Telegram HTML。
 * 只处理 agent 回答里实际会出现的：**粗体**、`行内代码`、```代码块```、
 * __粗体__、*斜体*、~~删除线~~、# 标题、> 引用、- 列表。
 * **先转义，后插标签**。
 *
 * ⚠️ 2026-09-15 加标题/引用/列表。**块级规则必须放在 keep() 占位符之后**：
 *    否则代码块里的 `# 注释`、`> 引用`、`- 参数` 会被当成真的语法改写。
 *    这是铁律 1 的延伸 —— 不光是转义顺序，块级规则也有先后。
 *
 * ⚠️ Telegram **没有** <h1>~<h6>，标题只能用 <b> 模拟（ALLOWED_TAGS 里也没有 h*）。
 *    所以 `## 标题` 渲染成加粗、去掉 `#` 号；`###` 及以上额外缩进两空格保留层级感。
 *    想要"像微信那样显示真标题"在 TG 做不到，这是平台限制，不是实现偷懒。
 *
 * ⚠️ 2026-09-15 表格改为「键值条目」形态（原先是**故意不处理**）：
 *    TG 无 <table>；实测「包进 <pre>」也不可行 —— 等宽字体对中文基本无效，
 *    按「中文=2 宽」补空格只能做到"大致齐"，换设备/换字号立刻崩。
 *    所以彻底放弃列对齐，改用不依赖对齐的形态。
 */
export function markdownToHtml(text) {
  let s = escapeHtml(text);
  // 代码块/行内代码里的 ** 和 _ 是字面量，不能被当成标记再替换一次。
  // 做法：先把它们替换成占位符，等其它规则跑完再还原。
  // （直接替换成 <pre> 是不行的——后续正则仍会进到标签**内部**去改内容。）
  const stash = [];
  const keep = (html) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };
  s = s.replace(/```([\s\S]+?)```/g, (_, code) => keep(`<pre>${code.trim()}</pre>`));
  s = s.replace(/`([^`\n]+?)`/g, (_, code) => keep(`<code>${code}</code>`));

  // ---- 块级规则（必须在 keep() 之后）------------------------------------
  // 标题：行首锚定 + `m` 标志。`C# 语言` 里的 # 不在行首，不会被误伤。
  // 结尾的 `#*` 兼容 `## 标题 ##` 这种闭合写法。
  s = s.replace(
    /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm,
    (_, hashes, title) => `<b>${hashes.length >= 3 ? '  ' : ''}${title}</b>`,
  );

  // 引用：连续 `> ` 行合并成**一个** <blockquote>，
  // 避免每行一个标签把手机排版撑散。
  s = s.replace(
    /^(?:&gt;[ \t]?.*(?:\n|$))+/gm,
    (block) => {
      const inner = block
        .replace(/\n$/, '')
        .split('\n')
        .map((line) => line.replace(/^&gt;[ \t]?/, ''))
        .join('\n');
      return `<blockquote>${inner}</blockquote>\n`;
    },
  );

  // 无序列表：`- ` / `* ` / `+ ` → `• `。行首锚定，`a - b` 不受影响。
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '• ');

  // 表格 → 键值条目（见函数头注释：放弃列对齐，改用不依赖对齐的形态）。
  // ⚠️ 必须在 keep() 之后：代码块里的 `|` 已变成占位符，不会被误判成表格。
  // ⚠️ 必须在行内规则之前：单元格里的 `**粗体**` / `\`代码\`` 还要被后续规则处理。
  s = convertTables(s);

  // ---- 行内规则 ---------------------------------------------------------
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([\s\S]+?)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
  s = s.replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');

  // 还原占位符（内容已在 escapeHtml 阶段转义过，安全）
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  return s;
}

/**
 * 标签感知切分：按行边界切，并**保证每块内标签闭合**。
 * 做法：切分前记录当前未闭合的白名单标签，切点后在新块开头重新打开它们，
 * 在本块末尾补上对应的关闭标签。这样每块单独看都是合法 HTML。
 */
export function splitMessageHtml(text, limit = 4000) {
  const source = String(text ?? '');
  if (source.length <= limit) return [source];

  const chunks = [];
  let rest = source;
  const tagRe = /<(\/?)([a-zA-Z-]+)[^>]*>/g;

  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;

    let head = rest.slice(0, cut);
    let tail = rest.slice(cut).replace(/^\n/, '');

    // 统计 head 里未闭合的白名单标签（按出现顺序压栈）
    const open = [];
    for (const m of head.matchAll(tagRe)) {
      const [, closing, name] = m;
      if (!ALLOWED_TAGS.has(name.toLowerCase())) continue;
      if (closing) {
        const i = open.lastIndexOf(name);
        if (i >= 0) open.splice(i, 1);
      } else {
        open.push(name);
      }
    }

    if (open.length > 0) {
      // 本块末尾补关闭（逆序），下一块开头重新打开（正序）
      head += open.slice().reverse().map((t) => `</${t}>`).join('');
      tail = open.map((t) => `<${t}>`).join('') + tail;
    }

    chunks.push(head);
    rest = tail;
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** 校验一段 HTML 的标签是否配对（仅白名单标签）。用于发送前自检。 */
export function htmlIsBalanced(html) {
  const stack = [];
  for (const m of String(html ?? '').matchAll(/<(\/?)([a-zA-Z-]+)[^>]*>/g)) {
    const [, closing, name] = m;
    const tag = name.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (closing) {
      if (stack.pop() !== tag) return false;
    } else {
      stack.push(tag);
    }
  }
  return stack.length === 0;
}

/**
 * 便捷导出：把带 markdown 的文本以**格式化**方式发给 TG。
 * 等价于 `telegram.sendRich(...)`，供不便持有实例的调用点使用。
 */
export function sendRichTo(telegram, chatId, markdown, extra = {}) {
  return telegram.sendRich(chatId, markdown, extra);
}

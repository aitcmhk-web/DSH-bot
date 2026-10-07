// md2tg.mjs · markdown → Telegram HTML 转换层
// 移植自现役 bot 的 telegram.js sendRich 转换层（2026-10-05 核对同代码族源码原样搬运，行为零改动）。
// 只导出纯函数；发送动作在 access.mjs（底层发送只留一份，见契约「格式化输出」）。
//
// ⚠️ 三条铁律（改这段代码前必读，随源码一并移植）：
//   1. **先转义，再插标签**。反了会把刚生成的 <b> 又转义成可见的 &lt;b&gt;。
//   2. **切分必须标签感知**。若 <b> 在切口前、</b> 在切口后，两半都非法 → 双 400。
//      所以用 splitMessageHtml() 而不是 splitMessage()。
//   3. **发送失败要能降级**。含裸 `<`/`&` 的文本会让 Telegram 返回 400，
//      调用方若包在 try/catch 里会**静默丢消息**。降级逻辑见 access.mjs sendRichText()。

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
 * Telegram 没有 <table>：等宽字体对中文无效、列对齐换设备就崩，
 * 所以用不依赖对齐的「键值条目」形态（首列 ● 前缀 + 加粗作条目标题）。
 * 判定为表格的条件（从严，避免误伤正文里的 `|`）：
 *   1. 至少两行连续以 `|` 开头；
 *   2. 其中**存在**一行是分隔行（单元格只含 `-`、`:`、空格）。
 * 没有分隔行就不认，原样返回。
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
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const header = cells(lines[i]);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && isRow(lines[j])) {
        rows.push(cells(lines[j]));
        j++;
      }

      const entries = rows.map((row) => {
        const parts = [];
        row.forEach((value, col) => {
          if (value === '') return; // 空单元格直接跳过，不产生 `列名: ` 噪音
          const name = header[col] ?? '';
          if (col === 0) {
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
 * __粗体__、*斜体*、~~删除线~~、# 标题、> 引用、- 列表、表格。
 * **先转义，后插标签**；块级规则必须放在 keep() 占位符之后，
 * 否则代码块里的 `# 注释`、`> 引用`、`- 参数` 会被当成真的语法改写。
 * ⚠️ Telegram 没有 <h1>~<h6>，标题只能用 <b> 模拟——平台限制，不是实现偷懒。
 */
export function markdownToHtml(text) {
  let s = escapeHtml(text);
  // 代码块/行内代码里的 ** 和 _ 是字面量：先换成占位符，其它规则跑完再还原。
  const stash = [];
  const keep = (html) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };
  s = s.replace(/```([\s\S]+?)```/g, (_, code) => keep(`<pre>${code.trim()}</pre>`));
  s = s.replace(/`([^`\n]+?)`/g, (_, code) => keep(`<code>${code}</code>`));

  // ---- 块级规则（必须在 keep() 之后）------------------------------------
  // 标题：行首锚定 + `m` 标志。`C# 语言` 里的 # 不在行首，不会被误伤。
  s = s.replace(
    /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm,
    (_, hashes, title) => `<b>${hashes.length >= 3 ? '  ' : ''}${title}</b>`,
  );

  // 引用：连续 `> ` 行合并成**一个** <blockquote>，避免每行一个标签把手机排版撑散。
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

  // 表格 → 键值条目。必须在 keep() 之后（代码块里的 `|` 已成占位符）、
  // 行内规则之前（单元格里的 `**粗体**`/`` `代码` `` 还要被后续规则处理）。
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

/** Telegram 拒收超 4096 字符；按行边界切分（纯文本用）。 */
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
 * ⚠️ 只剥白名单标签、还原三个 HTML 实体，**不做 markdown 反解析**
 * （降级是保送达的兜底路径，格式丢失可接受）。
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

/**
 * 标签感知切分：按行边界切，并**保证每块内标签闭合**。
 * 切点前未闭合的白名单标签，在本块末尾补关闭、下一块开头重新打开。
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

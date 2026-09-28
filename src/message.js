/**
 * 本插件自带的「消息构造」——**故意不 import DSH 的内部包**。
 *
 * ⭐ 为什么要自己写（而不是 `import { createUserMessage } from '@deepseek-ai/dsh-llm'`）：
 *   实测从插件目录向上**找不到**任何 `@deepseek-ai/*` 包（见 probe-resolution.mjs 的输出，
 *   全部 MODULE_NOT_FOUND）。DSH 的包只装在 `~/.dsh/profiles/node_modules/` 和
 *   npx 缓存里，跟本插件不在同一条解析链上。
 *
 *   两个候选解法：
 *     ① 给插件目录建 node_modules 软链 / 在 profile 里登记依赖 —— 能行，但插件就
 *        **绑死在某一台机器的目录布局**上，发布给别人时要重来一遍，正是我们要摆脱的东西。
 *     ② 自己实现这几个纯函数 —— 它们本来就极小。
 *   选 ②。
 *
 * ⚠️ 每个函数的语义都**照抄官方实现**（不是凭印象写的），出处逐条标在函数上。
 *    语义抄错会导致消息结构不合宿主预期，属于「静默错」，比报错更难查。
 *
 * ⚠️ 一个刻意的取舍：官方 `createUserMessage` 返回的是 `structuredClone` 过的
 *    深冻结副本（`dsh-llm/lib/index.js:29-31`，冻结器来自 `dsh-util-values:194`，
 *    会把整棵对象树 freeze，遇到 AbortSignal/循环引用会跳过）。
 *    我们**不复制**，但同样深冻结 —— 因为 `structuredClone` 在这里唯一的实际作用是
 *    「防调用方随后改自己传进来的对象」，而深冻结同样能达到这个效果，
 *    且能避免 `content` 里出现不可克隆值时的意外报错。
 */

import { randomUUID } from 'node:crypto';

/** 深冻结整棵对象树。语义照抄 `@deepseek-ai/dsh-util-values` 的 `deepFreeze`（第 194 行起）。 */
function deepFreeze(value) {
  const seen = new WeakSet();
  const pending = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object') continue;
    if (node instanceof AbortSignal) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    Object.freeze(node);
    for (const key of Object.keys(node)) pending.push(node[key]);
  }
  return value;
}

/**
 * 造一条用户消息。
 *
 * 语义照抄 `dsh-llm/lib/index.js:37-53`：
 *   createUserMessage(input) = freeze({ ...input, role: 'user', id: <新 uuid> })
 *
 * @param {{content: Array<object>, source: object}} input 完整内容 + 来源标记
 * @returns 不可变的用户消息
 */
export function createUserMessage(input) {
  return deepFreeze({
    ...input,
    role: 'user',
    id: randomUUID(),
  });
}

/**
 * 把纯文本包成内容块数组。
 *
 * ⚠️ 内容块的形状（`{type:'text', text}`）取自官方 `createSystemMessage`
 *    （`dsh-llm/lib/index.js:76-88`）里同样用到的写法 —— 那里也是
 *    `{ type: 'text', text }`。
 *
 * @param {string} text
 * @returns {Array<{type:'text', text:string}>}
 */
export function textContent(text) {
  return [{ type: 'text', text }];
}

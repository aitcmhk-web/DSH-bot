/**
 * command-policy.js —— 斜杠命令「要不要排队」的唯一判断（2026-11-27 修 P0#4）。
 *
 * 背景：同一会话的回合必须串行（见 index.js 的 enqueue）。但命令入口原先绕过队列
 *   直接调 handleCommand，于是正跑着一轮时发 /new（resetSession）会把活动 agent
 *   dispose 掉，旧回合的 waitForTurn 再也等不到 turn/end，这条会话的队列一直卡到
 *   turnTimeoutMs（线上 3 小时）—— 表现就是「机器人哑了」。
 *
 * 口径：
 *   · 默认一律排队 —— 命令要读/改的正是队列在用的会话状态，抢跑就是串话。
 *   · 免排队只有两类，都是「救命/看诊」用的：
 *       /restart —— 进程卡死时必须立刻生效，排队等于把自救路堵上；
 *       /status /whoami /help /start —— 只读，不碰会话，卡死时正是要靠它们看状态。
 *
 * 单独成文件只为「可测」：这条判断一旦被改错，症状是几小时后才发作的哑掉，
 *   靠人眼看代码看不出来（见 test-turn-guards.mjs）。
 */

/** 免排队白名单：自救 + 只读。⛔ 别往里加会改会话的命令（/new、/model）。 */
const 免排队 = new Set(['/restart', '/status', '/whoami', '/help', '/start']);

/**
 * 这条命令要不要排进会话队列。
 * @param {string} command 已归一的小写命令（如 '/new'）
 * @returns {boolean} true = 排队；false = 立刻执行
 */
export function 要排队(command) {
  const cmd = String(command ?? '').trim().toLowerCase();
  return !免排队.has(cmd);
}

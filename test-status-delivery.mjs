// test-status-delivery.mjs — 回合收尾交付的限流重发与落盘兜底自测（离线，不碰网络 / DSH / 真会话）
//
// 跑法：node test-status-delivery.mjs
//
// 覆盖：
//   ① 编辑占位消息被限流一次 → 按 retry_after 等待后重发成功，占位消息最终是正式回答
//   ② 编辑与整条重发都被限流到预算耗尽 → 整篇回答落盘 + 占位消息改成「未送达」，⛔ 不许答案消失
//   ③ 超长回答分段补发、某段被限流一次 → 重试送达，既不留半篇也不误落盘
//   ④ 正常一轮（无 429）→ 行为与旧版一致：一次编辑、不落盘、不重发
//   ⑤ 非限流失败（占位消息被删/过期）→ 立即整条重发，不白等限流窗口
//
// 环境：预算压到 3s（DSH_BOTPLUGIN_RATE_LIMIT_BUDGET_MS）、落盘目录指到临时目录
//       （DSH_BOTPLUGIN_UNDELIVERED_DIR，故意选一个还不存在的子路径，顺带验自动建目录）。
//       全部在临时目录里跑，跑完删干净，不碰线上任何东西。

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const 临时根 = mkdtempSync(join(tmpdir(), 'status-delivery-'));
const 落盘目录 = join(临时根, '未送达'); // 故意不存在：验 #dumpUndelivered 自己建目录
process.env.DSH_BOTPLUGIN_UNDELIVERED_DIR = 落盘目录;
process.env.DSH_BOTPLUGIN_RATE_LIMIT_BUDGET_MS = '3000';

const { LiveStatus } = await import('./src/status.js');

// 插件里的等待定时器统一 unref（不影响线上进程退出），故自测要自己保活，否则进程会提前退出。
const 保活 = setInterval(() => {}, 1000);

let 过 = 0;
const 断言 = (条件, 说明) => {
  assert.ok(条件, 说明);
  过 += 1;
  console.log(`  ✅ ${说明}`);
};

/** 造一个 Telegram 限流错误（形状照 telegram.js 抛的：errorCode + parameters.retry_after）。 */
function 限流(秒) {
  return Object.assign(new Error(`sendMessage: Too Many Requests: retry after ${秒}`), {
    errorCode: 429,
    description: `Too Many Requests: retry after ${秒}`,
    parameters: { retry_after: 秒 },
  });
}

/**
 * 假 Telegram：只记调用、按脚本抛错，不发网络。
 * 脚本字段：编辑 / 发送 / 重发 三条队列（元素为 Error 表示这一步抛错，队列空了默认成功）；
 *          编辑恒限流 / 发送恒限流 / 重发恒限流 = 该动作每次都抛这个错。
 */
function 假TG(脚本 = {}) {
  const 队 = { 编辑: [...(脚本.编辑 ?? [])], 发送: [...(脚本.发送 ?? [])], 重发: [...(脚本.重发 ?? [])] };
  const 记录 = { 编辑: [], 发送: [], 重发: [], typing: 0 };
  const 取步 = (名) => {
    if (脚本[`${名}恒限流`]) return 脚本[`${名}恒限流`];
    return 队[名].length ? 队[名].shift() : null;
  };
  return {
    记录,
    async sendMessage(chat, text) {
      记录.发送.push(text);
      const 步 = 取步('发送');
      if (步 instanceof Error) throw 步;
      return { message_id: 900 + 记录.发送.length };
    },
    async editMessageText(chat, id, text) {
      记录.编辑.push(text);
      const 步 = 取步('编辑');
      if (步 instanceof Error) throw 步;
      return true;
    },
    async sendChatAction() {
      记录.typing += 1;
      return true;
    },
    async sendRich(chat, markdown) {
      记录.重发.push(markdown);
      const 步 = 取步('重发');
      if (步 instanceof Error) throw 步;
      return true;
    },
  };
}

const 数落盘 = () => (existsSync(落盘目录) ? readdirSync(落盘目录).filter((f) => f.endsWith('.md')) : []);

/** 跑一轮收尾：假 TG + 已发出的占位消息（begin() 的网络动作不在本自测范围内）。 */
async function 收尾一轮(脚本, 答案) {
  const tg = 假TG(脚本);
  const 错 = [];
  const 状态 = new LiveStatus({
    kind: 'tg',
    telegram: tg,
    chatId: 7934872283,
    log: () => {},
    error: (m) => 错.push(String(m)),
  });
  状态.messageId = 555;
  await 状态.finish(答案);
  return { tg, 错 };
}

console.log('— ① 限流一次后重发成功 —');
{
  const { tg, 错 } = await 收尾一轮({ 编辑: [限流(1)] }, '答案一');
  断言(tg.记录.编辑.at(-1).includes('答案一'), '① 占位消息最终是正式回答');
  断言(tg.记录.编辑.some((t) => t.includes('限流中')), '① 等待期间占位消息说明了「限流中，约 N 秒」');
  断言(错.some((m) => m.includes('被 Telegram 限流')), '① 日志记下被限流与重发');
  断言(数落盘().length === 0, '① 不该落盘');
}

console.log('— ② 限流到预算耗尽 → 落盘兜底 —');
{
  const { tg, 错 } = await 收尾一轮({ 编辑恒限流: 限流(1), 重发恒限流: 限流(1) }, '答案二·整篇不许丢');
  const 文件 = 数落盘();
  断言(文件.length === 1, '② 整篇回答落盘一份（目录是自动建出来的）');
  断言(
    readFileSync(join(落盘目录, 文件[0]), 'utf8').includes('答案二·整篇不许丢'),
    '② 落盘内容就是整篇回答',
  );
  断言(tg.记录.编辑.some((t) => t.includes('未送达')), '② 占位消息改成「未送达 + 路径」，不再停在「正在处理」');
  断言(错.some((m) => m.includes('已落盘')), '② 日志给出落盘路径');
  rmSync(join(落盘目录, 文件[0])); // 清掉本步落的盘，免得污染后面的「不落盘」断言
}

console.log('— ③ 超长回答分段补发被限流一次 —');
{
  const 长答案 = '甲乙丙丁戊己庚辛'.repeat(600); // 4800 字 → 分段
  const { tg } = await 收尾一轮({ 发送: [限流(1)] }, 长答案);
  断言(tg.记录.发送.length === 2, '③ 分段被限流一次后重试送达（2 次尝试）');
  断言(tg.记录.发送.at(-1).includes('甲乙丙丁'), '③ 补发的确实是后半篇内容');
  断言(数落盘().length === 0, '③ 全部送达，不落盘');
}

console.log('— ④ 正常一轮行为不变 —');
{
  const { tg, 错 } = await 收尾一轮({}, '正常答案');
  断言(tg.记录.编辑.length === 1 && tg.记录.编辑[0].includes('正常答案'), '④ 只编辑一次占位消息，内容就是回答');
  断言(tg.记录.发送.length === 0 && tg.记录.重发.length === 0, '④ 无重发、无补发');
  断言(错.length === 0, '④ 无错误日志');
  断言(数落盘().length === 0, '④ 不落盘');
}

console.log('— ⑤ 非限流失败立即整条重发，不白等 —');
{
  const 起 = Date.now();
  const { tg } = await 收尾一轮({ 编辑: [new Error('Bad Request: message to edit not found')] }, '答案五');
  const 耗时 = Date.now() - 起;
  断言(tg.记录.重发.length === 1, '⑤ 占位消息发不动 → 立即整条重发');
  断言(耗时 < 1000, `⑤ 不是限流就不等（实测 ${耗时}ms）`);
  断言(数落盘().length === 0, '⑤ 整条重发成功，不落盘');
}

clearInterval(保活);
rmSync(临时根, { recursive: true, force: true });
console.log(`\n全部通过：${过} 项`);
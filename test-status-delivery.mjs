// test-status-delivery.mjs — 回合收尾交付自测（离线，不碰网络 / DSH / 真会话）
//
// 跑法：node test-status-delivery.mjs
//
// 口径（2026-10-20 定）：占位消息**只报进度**，⛔ 收尾不再写「✅ 已回复」——回答进窗口后
// **把气泡删掉**；没送达才保留气泡并标「未送达」。最终回答统一由节点广播到所有端点
// （见 src/index.js 收尾交付），⛔ 不进占位消息。
//
// 覆盖：
//   ① 收尾不写任何东西；回答进窗口后删掉气泡
//   ② 迟到的进度编辑不再上屏（收尾先等「在飞编辑」落地）；回答正文一个字都不进气泡（回归锁）
//   ③ 气泡删不动：只记日志、不抛
//   ④ 落盘兜底：正文落盘、目录自动建、气泡改标「未送达」（⛔ 不删）
//   ⑤ 广播链路 sendRich：撞 429 按 retry_after 重发后送达
//   ⑥ 排版被拒（400）→ 只从失败那块起降级纯文本
//   ⑦ 429 等不起（超预算）→ 抛出，交调用方兜底
//
// 环境：预算压到 3s（DSH_BOTPLUGIN_RATE_LIMIT_BUDGET_MS）、落盘目录指到临时目录
//       （DSH_BOTPLUGIN_UNDELIVERED_DIR，故意选一个还不存在的子路径，顺带验自动建目录）。
//       全部在临时目录里跑，跑完删干净，不碰线上任何东西。

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const 临时根 = mkdtempSync(join(tmpdir(), 'status-delivery-'));
const 落盘目录 = join(临时根, '未送达'); // 故意不存在：验「落盘未送达」自己建目录
process.env.DSH_BOTPLUGIN_UNDELIVERED_DIR = 落盘目录;
process.env.DSH_BOTPLUGIN_RATE_LIMIT_BUDGET_MS = '3000';

const { LiveStatus, 落盘未送达 } = await import('./src/status.js');
const { Telegram } = await import('./src/telegram.js');

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

/** 假 Telegram：只记调用、按脚本抛错，不发网络。 */
function 假TG(脚本 = {}) {
  const 队 = { 编辑: [...(脚本.编辑 ?? [])], 发送: [...(脚本.发送 ?? [])], 删除: [...(脚本.删除 ?? [])] };
  const 记录 = { 编辑: [], 发送: [], 删除: [], typing: 0 };
  const 取步 = (名) => (队[名].length ? 队[名].shift() : null);
  return {
    记录,
    async sendMessage(chat, text, extra) {
      记录.发送.push({ text, extra });
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
    async deleteMessage(chat, id) {
      记录.删除.push(id);
      const 步 = 取步('删除');
      if (步 instanceof Error) throw 步;
      return true;
    },
    async sendChatAction() {
      记录.typing += 1;
      return true;
    },
  };
}

const 数落盘 = () => (existsSync(落盘目录) ? readdirSync(落盘目录).filter((f) => f.endsWith('.md')) : []);

/** 造一个「占位消息已发出」的 TG 活状态（begin() 的网络动作不在本自测范围内）。 */
function 造状态(tg, 错 = []) {
  const 状态 = new LiveStatus({
    kind: 'tg',
    telegram: tg,
    chatId: 7934872283,
    log: () => {},
    error: (m) => 错.push(String(m)),
  });
  状态.messageId = 555;
  return 状态;
}

console.log('— ① 收尾不写任何东西；回答进窗口后删气泡 —');
{
  const 错 = [];
  const tg = 假TG();
  const 状态 = 造状态(tg, 错);
  状态.推正文('我先摸四样：服务的健康口、待办清单、台账、插件版本。');
  状态.addNote('🏃 跑命令: for p in 7788:数据机 7789:消息窗口 …');
  状态.trackProgress(100, 2000); // 2 秒吐 100 字 → 有实测速度，小尾巴才出得来
  const 尾巴 = await 状态.finish();
  断言(tg.记录.编辑.length === 0, '① 收尾⛔ 不再写「✅ 已回复」（还没到点的进度编辑也一并取消）');
  断言(tg.记录.删除.length === 0, '① finish() 自己不删气泡（删只在回答进窗口后做）');
  断言(typeof 尾巴 === 'string' && 尾巴.includes('字/秒'), '① 小尾巴交回调用方（跟回答一起广播）');
  断言(错.length === 0, '① 无错误日志');
  await 状态.清气泡();
  断言(tg.记录.删除.length === 1 && tg.记录.删除[0] === 555, '① 回答进窗口后删掉占位气泡（删的是 555 那条）');
}

console.log('— ② 迟到的进度编辑不再上屏（收尾先等在飞编辑落地）—');
{
  const 错 = [];
  const tg = 假TG();
  let 放行 = () => {};
  const 闸 = new Promise((r) => { 放行 = r; });
  const 原编辑 = tg.editMessageText;
  tg.editMessageText = async (chat, id, text) => {
    const 果 = await 原编辑(chat, id, text);
    if (tg.记录.编辑.length === 1) await 闸; // 第一次进度编辑卡在路上
    return 果;
  };
  const 状态 = 造状态(tg, 错);
  状态.推正文('我先摸四样。');
  状态.addNote('🏃 跑命令: ls');
  await new Promise((r) => setTimeout(r, 2200)); // 等去抖到点，让那次编辑发出去并卡住
  断言(tg.记录.编辑.length === 1, '② 第一次进度编辑已发出（卡在路上）');
  const 收尾 = 状态.finish();
  await new Promise((r) => setTimeout(r, 20));
  放行();
  await 收尾;
  断言(tg.记录.编辑.length === 1, '② 收尾⛔ 不补任何行（迟到那次落地后不再写）');
  断言(!tg.记录.编辑.at(-1).includes('✅ 已回复'), '② 气泡上没有收尾语');
  断言(!tg.记录.编辑.at(-1).includes('这份报告'), '② 回答正文一个字都不进气泡（回归锁）');
}

console.log('— ③ 气泡删不动：只记日志、不抛 —');
{
  const 错 = [];
  const tg = 假TG({ 删除: [new Error('Bad Request: message to delete not found')] });
  const 状态 = 造状态(tg, 错);
  状态.推正文('我开始了。');
  let 抛了 = null;
  try {
    await 状态.finish();
    await 状态.清气泡();
  } catch (err) {
    抛了 = err;
  }
  断言(抛了 === null, '③ 气泡删不动也不抛（回答走广播，不受影响）');
  断言(错.some((m) => m.includes('占位气泡没删掉')), '③ 日志记下气泡没删掉');
}

console.log('— ④ 落盘兜底 —');
{
  const 错 = [];
  const 文件 = await 落盘未送达('整篇回答·不许丢', '广播到 tg 失败', { 记日志: (m) => 错.push(String(m)), 渠道: 'tg' });
  断言(typeof 文件 === 'string' && 文件.endsWith('.md'), '④ 落盘返回文件路径（目录是自动建出来的）');
  断言(readFileSync(文件, 'utf8').includes('整篇回答·不许丢'), '④ 落盘内容就是整篇正文');
  断言(错.some((m) => m.includes('已落盘')), '④ 日志给出落盘路径');

  const tg = 假TG();
  const 状态 = 造状态(tg, 错);
  await 状态.标未送达('广播到 tg 失败', 文件);
  断言(tg.记录.编辑.at(-1).includes('未送达'), '④ 气泡改标「未送达」（没送达时气泡留着）');
  断言(tg.记录.删除.length === 0, '④ 未送达⛔ 不删气泡（还得让人看见）');
  for (const f of 数落盘()) rmSync(join(落盘目录, f)); // 清干净，免得污染后面的断言
}

console.log('— ⑤ 广播链路：撞 429 按 retry_after 重发 —');
{
  const t = new Telegram('测试令牌');
  let 次 = 0;
  t.sendMessage = async () => {
    次 += 1;
    if (次 === 1) throw 限流(1);
    return { message_id: 1 };
  };
  const 果 = await t.sendRich(1, '你好');
  断言(次 === 2, '⑤ 限流一次后重发（共 2 次调用）');
  断言(果.mode === 'html' && 果.chunks === 1, '⑤ 重发后带格式送达');
}

console.log('— ⑥ 排版被拒（400）→ 只从失败那块起降级纯文本 —');
{
  const t = new Telegram('测试令牌');
  const 发 = [];
  t.sendMessage = async (chat, text, extra) => {
    发.push({ text, extra });
    if (extra?.parse_mode) throw new Error('Bad Request: parse entities failed');
    return { message_id: 2 };
  };
  const 果 = await t.sendRich(1, '**加粗**');
  断言(果.mode === 'plain', '⑥ 结果标为纯文本送达');
  断言(发.length === 2 && !发[1].extra.parse_mode, '⑥ 降级那条不带 parse_mode');
}

console.log('— ⑦ 429 等不起（超预算）→ 抛出交调用方兜底 —');
{
  const t = new Telegram('测试令牌');
  t.sendMessage = async () => { throw 限流(60); }; // 60s 远超 3s 预算
  await assert.rejects(() => t.sendRich(1, '你好'), /Too Many Requests/);
  过 += 1;
  console.log('  ✅ ⑦ 限流等不起就抛出（节点会记失败，回答另走落盘兜底）');
}

clearInterval(保活);
rmSync(临时根, { recursive: true, force: true });
console.log(`\n全部通过：${过} 项`);

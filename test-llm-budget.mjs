/**
 * test-llm-budget.mjs —— 模型流量闸（`src/llm-budget.js`）的离线自测。
 *
 * 跑法：node test-llm-budget.mjs
 *
 * 覆盖：
 *   ① 预估：中文按 1 token/字、英文按 1/4；请求体里元数据（provider/model/sessionId…）不算进去
 *   ② 用量：usage 块的几种形状都认得（totalTokens 优先，其次 input+output，再带缓存读写）
 *   ③ 闸：额度够时不排队；请求数超（rpm）排队等；token 超（tpm）排队等
 *   ④ 窗口是滚动的：等够 60 秒后老记录过期，又能发
 *   ⑤ 实际用量**替换**预估（不是叠加）
 *   ⑥ 等满「最长等待」就放行并告警（fail-open），统计里记一笔
 *   ⑦ 挂闸：假 ctx 收监听、流原样转发（块一个不少、一块不改）、用量入账
 *
 * ⛔ 不连网、不打真模型：时钟与睡觉都是注入的假的。
 */

import assert from 'node:assert/strict';
import {
  默认预算, 窗口毫秒, 估文本token, 预估请求, 取用量, 建闸, 挂闸,
} from './src/llm-budget.js';

let 过 = 0; const 掛 = [];
const 断言 = (条, 名) => { if (条) { 过 += 1; console.log(`  ✓ ${名}`); } else { 掛.push(名); console.log(`  ❌ ${名}`); } };

/** 假时钟：`现在()` 走人造时间，`睡(ms)` 直接把时间往前拨。 */
function 造假钟(起 = 1_700_000_000_000) {
  let 当下 = 起;
  const 睡过 = [];
  return {
    现在: () => 当下,
    睡: async (ms) => { 睡过.push(ms); 当下 += ms; },
    拨: (ms) => { 当下 += ms; },
    睡过,
    总睡: () => 睡过.reduce((a, b) => a + b, 0),
  };
}

console.log('① 预估：中英混排与元数据');
{
  断言(估文本token('你好') === 2, `中文一字一 token（${估文本token('你好')}）`);
  断言(估文本token('abcd') === 1, `英文四字一 token（${估文本token('abcd')}）`);
  断言(估文本token('你好abcd') === 3, `混排相加（${估文本token('你好abcd')}）`);
  断言(估文本token('') === 0 && 估文本token(null) === 0, '空值给 0');

  const 预估 = 预估请求({ provider: 'p', model: 'm', sessionId: 's', messages: [{ role: 'user', content: '你好世界' }] }, 100);
  断言(预估 === 104, `输入 4 字 + 输出预留 100（${预估}）`);
  const 顶格 = 预估请求({ messages: [{ content: '你好' }], maxTokens: 30 }, 100);
  断言(顶格 === 32, `请求自己的输出上限比预留小就按它算（${顶格}）`);
  断言(!JSON.stringify(预估请求({ provider: '很长很长的provider名字' })).includes('undefined'), '元数据不进预估也不炸');
}

console.log('② 用量：usage 块的几种形状');
{
  断言(取用量({ type: 'usage', usage: { totalTokens: 123 } }) === 123, 'totalTokens 优先');
  断言(取用量({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }) === 15, '没有总数就 input+output');
  断言(取用量({ usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 8, cacheWriteTokens: 2 } }) === 12, '缓存读写也算进额度');
  断言(取用量({ type: 'text' }) === 0 && 取用量(null) === 0, '没有用量回 0（调用方据此保留预估）');
}

console.log('③ 闸：够额度就放行、超了就排队');
{
  const 钟 = 造假钟();
  const 闸 = 建闸({ tpm: 1000, rpm: 3, 输出预留: 10, 现在: 钟.现在, 睡: 钟.睡, 记日志: false });

  for (let i = 0; i < 3; i += 1) await 闸.要额度(100);
  断言(闸.快照().窗口.请求数 === 3 && 钟.睡过.length === 0, '三次之内不排队');

  const p = 闸.要额度(100);
  await new Promise((r) => setTimeout(r, 0));
  断言(钟.睡过.length === 1 && 钟.睡过[0] > 0, `第四次开始排队（等了 ${钟.睡过[0]}ms）`);
  await p;
  断言(闸.快照().窗口.请求数 === 1 && 钟.总睡() >= 窗口毫秒, `等过一个窗口后老记录过期、窗口只剩新的这一条（睡了 ${钟.总睡()}ms）`);

  const 钟2 = 造假钟();
  const 闸2 = 建闸({ tpm: 250, rpm: 50, 输出预留: 0, 现在: 钟2.现在, 睡: 钟2.睡, 记日志: false });
  await 闸2.要额度(200);
  const p2 = 闸2.要额度(200);
  await new Promise((r) => setTimeout(r, 0));
  断言(钟2.睡过.length === 1, 'token 顶到上限也会排队（不是只看次数）');
  await p2;
  断言(闸2.快照().窗口.token === 200, `等过窗口后只留新的一条（窗口 ${闸2.快照().窗口.token} token）`);
}

console.log('④ 实际用量替换预估（不是叠加）');
{
  const 钟 = 造假钟();
  const 闸 = 建闸({ tpm: 1000, rpm: 50, 现在: 钟.现在, 睡: 钟.睡, 记日志: false });
  const 号 = await 闸.要额度(500);            // 先按 500 占位
  断言(闸.快照().窗口.token === 500, '占位先记账');
  闸.记用量(号, 120);                          // 实际只有 120
  断言(闸.快照().窗口.token === 120, `实际回来就替换掉（窗口 ${闸.快照().窗口.token}，不是 620）`);
  闸.记用量(号, 0);
  断言(闸.快照().窗口.token === 120, '没拿到用量（0）就保留原值，不归零');
}

console.log('⑤ 等满最长等待就放行并告警（fail-open）');
{
  const 钟 = 造假钟();
  const 日志们 = [];
  const 闸 = 建闸({
    tpm: 100, rpm: 1, 现在: 钟.现在, 睡: 钟.睡,
    最长等待毫秒: 5000, 日志: (m) => 日志们.push(String(m)),
  });
  await 闸.要额度(50);
  const 号 = await 闸.要额度(50);               // 请求数超，会一直等；最长等待 5 秒
  断言(号 > 0 && 闸.快照().统计.放行超限 === 1, '等满就放行一次（统计里记「超限放行」）');
  断言(日志们.some((m) => m.includes('放行一次')), '放行时打了告警');
  断言(钟.总睡() >= 5000 && 钟.总睡() < 窗口毫秒, `等够阈值就停（共睡 ${钟.总睡()}ms，没傻等一分钟）`);
}

console.log('⑥ 挂闸：监听、原样转发、用量入账');
{
  const 监听 = {};
  const ctx = { on: (名, 手) => { 监听[名] = 手; } };
  const 钟 = 造假钟();
  const 闸 = 挂闸(ctx, { tpm: 1000, rpm: 50, 现在: 钟.现在, 睡: 钟.睡, 记日志: false }, () => {});
  断言(typeof 监听['llm/stream'] === 'function', '挂到了 llm/stream 上');

  const 原块 = [
    { type: 'text', text: '你' },
    { type: 'text', text: '好' },
    { type: 'usage', usage: { totalTokens: 42 } },
    { type: 'finish', reason: 'stop' },
  ];
  const 收到 = [];
  const 流 = 监听['llm/stream']({ provider: 'p', model: 'm', messages: [{ content: '你好' }] }, () => (async function* () { for (const b of 原块) yield b; })());
  for await (const b of 流) 收到.push(b);
  断言(收到.length === 4 && 收到.every((b, i) => b === 原块[i]), '四块原样转发（同一个对象、顺序不变、一块不落）');
  断言(闸.快照().窗口.token === 42, `用量走了实际值（窗口 ${闸.快照().窗口.token}）`);
  断言(闸.快照().窗口.请求数 === 1, '这次调用算一次请求');
}

console.log('⑦ 口径默认值（老板 2026-10-19 定）');
{
  断言(默认预算.tpm === 800000, `默认每分钟 80 万 token（${默认预算.tpm}）`);
  断言(默认预算.rpm === 50, `默认每分钟 50 次请求（${默认预算.rpm}）`);
  断言(窗口毫秒 === 60000, '窗口是一分钟');
}

console.log(`\n流量闸自测：过 ${过} 项，不过 ${掛.length} 项`);
if (掛.length) { console.log('挂的：'); for (const g of 掛) console.log(`  ❌ ${g}`); process.exit(1); }
assert.ok(true);
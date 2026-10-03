// src/hard-rules.js 冒烟测试：按「步」计数 + 第 1 步注入 + 两个坑。
// 跑法：node test-hard-rules.mjs
import assert from 'node:assert/strict';
import { createHardRulesHandler, HARD_RULES_EVERY_N } from './src/hard-rules.js';

const BODY = '最高指令正文';

/** 造一个「本步待发消息 + 宿主追加 context」的假 decision。 */
function hostDecision(claimed, hostExtra = '宿主 context') {
  return { kind: 'accept', messages: [...claimed, { role: 'user', content: [{ type: 'text', text: hostExtra }] }] };
}

function argsFor(claimed, { id = 'a', turn = 1, step = 1 } = {}) {
  return { messages: claimed, agent: { id }, turn, step };
}

// ① 空正文 → 返回 null（调用方跳过挂载）
assert.equal(createHardRulesHandler({ text: '   ' }), null, '空正文必须返回 null');
assert.throws(() => createHardRulesHandler({ text: BODY, everyN: 0 }), TypeError, 'everyN=0 必须抛');

// ② 频率：第 1 步注入，2..N 步不注入，第 N+1 步再注入
const injected = [];
const h = createHardRulesHandler({ text: BODY, everyN: HARD_RULES_EVERY_N, log: (m) => injected.push(m) });
assert.ok(h, '正文非空必须返回 handler');

let step = 0;
const claim = () => [{ role: 'user', content: [{ type: 'text', text: `claimed-${step}` }] }];

async function runStep(extra = {}) {
  step += 1;
  const claimed = claim();
  const decision = await h(argsFor(claimed, { step, ...extra }), async () => hostDecision(claimed));
  const hit = decision.messages.some((m) => m?.source?.kind === 'hard-rules');
  return { decision, claimed, hit };
}

const first = await runStep();
assert.equal(first.hit, true, `第 1 步必须注入（实际 steps=${step}）`);
// 注入位置：紧跟在「本步待发消息」之后
const idx = first.decision.messages.findIndex((m) => m?.source?.kind === 'hard-rules');
assert.equal(idx, first.claimed.length, '注入必须插在 claimed 之后');

for (let i = 2; i <= HARD_RULES_EVERY_N; i += 1) {
  const r = await runStep();
  assert.equal(r.hit, false, `第 ${i} 步不该注入`);
}
const eleventh = await runStep();
assert.equal(eleventh.hit, true, `第 ${HARD_RULES_EVERY_N + 1} 步必须注入（实际 steps=${step}）`);

// ③ 坑①：空转步不记账、不注入、把宿主决定原样交回
const before = step;
const emptyDecision = await h(argsFor([], { step: step + 1 }), async () => ({ kind: 'accept', messages: [] }));
assert.deepEqual(emptyDecision, { kind: 'accept', messages: [] }, '空转步必须原样交回宿主决定');
const afterEmpty = await runStep();
assert.equal(afterEmpty.hit, false, '空转步不该被记账（否则第 1 步就会提前触发）');
assert.equal(step, before + 1, '空转步不该计数');

// ④ 坑②：同一步被双挂载触发两次 → 只计 1 次、只注 1 次
const dblHandler = createHardRulesHandler({ text: BODY, everyN: 2, log: () => {} });
const hitCount = (d) => (Array.isArray(d?.messages) ? d.messages.filter((m) => m?.source?.kind === 'hard-rules').length : 0);
const c1 = claim();
const a1 = argsFor(c1, { step: 1 });
const d1 = await dblHandler(a1, async () => hostDecision(c1));
const d2 = await dblHandler(a1, async () => hostDecision(c1)); // 同一步、第二次触发
assert.equal(hitCount(d1), 1, '第 1 步必须注入');
assert.equal(hitCount(d2), 0, '同一步的第二次触发不该再注一遍');
// 若去重失效（重复计数），下面的第 2 步会被当成第 3 步 → 又注一次
const cStep2 = claim();
const atStep2 = await dblHandler(argsFor(cStep2, { step: 2 }), async () => hostDecision(cStep2));
assert.equal(hitCount(atStep2), 0, 'everyN=2 时第 2 步不该注入 —— 若注入说明同一步被计了两次');
const cStep3 = claim();
const atStep3 = await dblHandler(argsFor(cStep3, { step: 3 }), async () => hostDecision(cStep3));
assert.equal(hitCount(atStep3), 1, 'everyN=2 时第 3 步必须注入（证明去重后步数正好是 3）');

// ⑤ 宿主 reject → 原样返回，不许注入
const c2 = claim();
const rejected = await dblHandler(argsFor(c2, { step: 2 }), async () => ({ kind: 'reject', reason: 'x' }));
assert.deepEqual(rejected, { kind: 'reject', reason: 'x' }, 'reject 必须原样返回');

// ⑥ 宿主 decision 里没有 messages → 不许注入、不许炸
const c3 = claim();
const noMsgs = await dblHandler(argsFor(c3, { step: 3 }), async () => ({ kind: 'accept' }));
assert.deepEqual(noMsgs, { kind: 'accept' }, '没有 messages 时原样返回');

console.log(`✅ 全绿：注入 ${injected.length} 次（everyN=${HARD_RULES_EVERY_N}）`);

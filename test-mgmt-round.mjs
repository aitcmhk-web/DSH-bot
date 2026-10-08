// test-mgmt-round.mjs — 例行管理回合回归测试（任务 #34，独立跑，不依赖 DSH/网络/真表）
//
// 跑法：node test-mgmt-round.mjs（也兼容 node --test test-mgmt-round.mjs）
//
// 覆盖（与任务判据一一对应）：
//   ① 到点触发：打桩定时器（假 now）验证 followup（fire→runtime.prompt）收到固定提示词，
//      且 30 分钟窗口内只触发一次；结束 busy 复位
//   ② 未到拍静默跳过（零日志零触发，5 分钟一拍不刷屏）
//   ③ 反向：忙时跳过不堆叠 —— 上一回合未结束（fire 挂着），到点也只跳过、不重入
//   ④ 反向：fire 失败也解锁（busy 复位），下一拍到点能再触发（一次失败不永久卡死）
//   ⑤ fireMgmtRound：runtime.prompt 收到会话 mgmt-round + 固定提示词（一字不改），
//      waitForTurn 同 key 收尾；[mgmt-round] 心跳落「排队/结束」
//   ⑥ 反向：排队失败 / 回合未完成 → reject（错误原样冒出）
//   ⑦ 常量护栏：MGMT_ROUND_MS=30 分钟、提示词与任务书原文一致（改常量/文案时这里红）
//   ⑧ 接线防回归（静态断言）：src/index.js 必须「import + 真调用点」齐全 —— 本任务
//      死因 = import 后零调用点（代码从未跑过）；调用点必须在 BOT_ROLE=master 门内、
//      onHeartbeat 挂在 createHerdWatchdog deps（与 #32 看门狗同拍，第 1 条）、dispose 随 herd 停。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MGMT_ROUND_MS,
  MGMT_ROUND_PROMPT,
  MGMT_CHAT_KEY,
  makeMgmtState,
  mgmtRoundTick,
  fireMgmtRound,
} from './src/mgmt-round.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✅ ${name}`);
};

/** 把微任务队列（含 finally）冲干净：setImmediate 两跳足够。 */
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

// ── ⑦ 常量护栏（先钉死，后面用例都靠它）────────────────────────────────────
assert.equal(MGMT_ROUND_MS, 30 * 60 * 1000, '管理回合节奏 = 每 30 分钟（常量可调，改了这里要同步任务书）');
assert.equal(
  MGMT_ROUND_PROMPT,
  '例行管理回合：①读任务表——查待验收/待审核/打回/进行中各行与四小工日志新鲜度；' +
    '②该验收当场验收、该发版当场发版、该派活当场派、卡住推动；' +
    '③收尾给协作群一句话（做了什么/发现什么/无异常也要说）。',
  '回合提示词 = 任务 #34 固定脚本，一字不改',
);
assert.equal(MGMT_CHAT_KEY, 'mgmt-round', '专用会话 key（不与真实 chat 历史互相污染）');
ok('⑦ 常量护栏：30 分钟节奏 + 任务书固定提示词一字不改 + 专用会话 key');

// ── ① 到点触发、窗口内只触发一次、结束 busy 复位 ───────────────────────────
{
  const state = makeMgmtState();
  const fires = [];
  const logs = [];
  let release;
  const gate = new Promise((r) => { release = r; }); // fire 挂着 = 回合进行中
  const deps = {
    fire: () => { fires.push(1); return gate; },
    log: (m) => logs.push(m),
    error: () => {},
  };
  const t0 = 1_700_000_000_000;
  assert.equal(mgmtRoundTick(state, deps, t0), true, '首拍（lastFiredAt=0 = 从未发过）应触发');
  await flush(); // fire 由微任务带起（tick 只置 busy/lastFiredAt 不 await fire —— 任务书设计），先冲一拍再断言
  assert.equal(fires.length, 1);
  assert.equal(state.busy, true, 'fire 未结束 busy 应保持（防堆叠标志已置位）');
  assert.equal(state.lastFiredAt, t0, '触发时刻入账（下一拍从它起算 30 分钟）');
  assert.ok(logs.some((m) => m.startsWith('[mgmt-round]') && m.includes('管理回合触发')), '触发心跳落 [mgmt-round]');
  // 30 分钟窗口内的拍子（含到点前 1ms）一律不重触发
  assert.equal(mgmtRoundTick(state, deps, t0 + 60_000), false);
  assert.equal(mgmtRoundTick(state, deps, t0 + MGMT_ROUND_MS - 1), false);
  assert.equal(fires.length, 1, '窗口内不许二次触发（只触发一次）');
  release(); // 回合结束
  await flush();
  assert.equal(state.busy, false, '回合结束 busy 复位');
  ok('① 到点触发、30 分钟窗口内只触发一次、结束 busy 复位、心跳落 [mgmt-round]');
}

// ── ② 未到拍静默跳过 ────────────────────────────────────────────────────────
{
  const state = makeMgmtState();
  state.lastFiredAt = 1_700_000_000_000;
  const fires = [];
  const logs = [];
  const deps = { fire: () => { fires.push(1); }, log: (m) => logs.push(m), error: () => {} };
  assert.equal(mgmtRoundTick(state, deps, state.lastFiredAt + MGMT_ROUND_MS - 1), false, '未到 30 分钟不触发');
  assert.equal(fires.length, 0);
  assert.deepEqual(logs, [], '未到拍静默跳过（每 5 分钟一拍都进这里，写日志纯属刷屏）');
  ok('② 未到拍静默跳过：零触发零日志');
}

// ── ③ 反向：忙时跳过不堆叠 ─────────────────────────────────────────────────
{
  const state = makeMgmtState();
  state.busy = true; // 上一管理回合未结束
  state.lastFiredAt = 1_700_000_000_000 - MGMT_ROUND_MS - 1; // 时间上也到点了
  const fires = [];
  const logs = [];
  const deps = { fire: () => { fires.push(1); }, log: (m) => logs.push(m), error: () => {} };
  const before = state.lastFiredAt;
  assert.equal(mgmtRoundTick(state, deps, 1_700_000_000_000), false, '到点但忙 → 跳过');
  assert.equal(fires.length, 0, '忙时不许再排队（followup 排队语义下再排只会堆积）');
  assert.equal(state.busy, true, 'busy 保持（等在途回合自然收尾解锁）');
  assert.equal(state.lastFiredAt, before, '跳过拍不刷新触发时刻');
  assert.ok(
    logs.some((m) => m.includes('[mgmt-round]') && m.includes('上一管理回合未结束') && m.includes('跳过')),
    '忙跳过要落 [mgmt-round] 心跳',
  );
  ok('③ 反向：忙时跳过不堆叠、心跳可查');
}

// ── ④ 反向：fire 失败也解锁 ────────────────────────────────────────────────
{
  const state = makeMgmtState();
  const errors = [];
  const deps = {
    fire: () => Promise.reject(new Error('定时桩失败')),
    log: () => {},
    error: (m) => errors.push(m),
  };
  const t0 = 1_700_000_000_000;
  assert.equal(mgmtRoundTick(state, deps, t0), true);
  await flush();
  assert.equal(state.busy, false, '失败也复位（一次失败不许把管理回合永久卡死）');
  assert.ok(errors.some((m) => m.includes('[mgmt-round]') && m.includes('管理回合失败') && m.includes('定时桩失败')), '失败落 error 心跳');
  // 下一拍到点：能再触发
  assert.equal(mgmtRoundTick(state, deps, t0 + MGMT_ROUND_MS), true, '失败后的下一拍能正常再触发');
  ok('④ 反向：fire 失败也解锁、下一拍能再触发');
}

// ── ⑤ fireMgmtRound：followup 收到固定提示词（真投递通路）───────────────────
{
  const calls = [];
  const turns = [];
  const logs = [];
  const runtime = {
    prompt: async (chatKey, content) => {
      calls.push({ chatKey, content });
      return { ok: true, messageId: 'm-42' };
    },
    waitForTurn: async (chatKey) => {
      turns.push(chatKey);
      return { ok: true };
    },
  };
  const done = await fireMgmtRound(runtime, { log: (m) => logs.push(m), error: () => {} });
  assert.equal(done?.ok, true);
  assert.equal(calls.length, 1, '一回合只排一条提示词');
  assert.equal(calls[0].chatKey, MGMT_CHAT_KEY, '投给专用会话 mgmt-round');
  assert.equal(calls[0].content, MGMT_ROUND_PROMPT, 'followup 收到的就是固定提示词，一字不改');
  assert.deepEqual(turns, [MGMT_CHAT_KEY], 'waitForTurn 等同会话收尾（照 runtime.js:279 排队语义）');
  assert.ok(logs.some((m) => m.includes('[mgmt-round]') && m.includes('提示词已排队') && m.includes('m-42')), '排队心跳');
  assert.ok(logs.some((m) => m.includes('[mgmt-round]') && m.includes('管理回合结束')), '收尾心跳');
  ok('⑤ fireMgmtRound：prompt 收到 mgmt-round + 固定提示词，waitForTurn 收尾，心跳齐');
}

// ── ⑥ 反向：排队失败 / 回合未完成 → reject ─────────────────────────────────
{
  const badQueue = {
    prompt: async () => ({ ok: false, error: '桩拒排队' }),
    waitForTurn: async () => ({ ok: true }),
  };
  await assert.rejects(fireMgmtRound(badQueue), /排队失败/, '排队失败要冒错（tick 侧 catch 落 error 心跳）');
  const badTurn = {
    prompt: async () => ({ ok: true, messageId: 'm-1' }),
    waitForTurn: async () => ({ ok: false, error: '桩超时' }),
  };
  await assert.rejects(fireMgmtRound(badTurn), /回合未完成/, '回合未完成要冒错');
  ok('⑥ 反向：排队失败 / 回合未完成都 reject');
}

// ── ⑧ 接线防回归（静态断言：import 后必须有真调用点）───────────────────────
{
  const src = readFileSync(new URL('./src/index.js', import.meta.url), 'utf8');
  assert.match(src, /import\s*\{[^}]*makeMgmtState[^}]*\}\s*from\s*'\.\/mgmt-round\.js'/, 'import 在');
  const iCall = src.indexOf('const mgmtState = makeMgmtState()');
  assert.ok(iCall > 0, 'makeMgmtState 必须有真调用点（本任务死因 = import 后零调用点）');
  assert.ok(
    src.slice(Math.max(0, iCall - 500), iCall).includes("=== 'master'"),
    '接线必须在 BOT_ROLE=master 角色门内（与 #32 herd / #33 triggers 同一门，第 1 条）',
  );
  const iHerd = src.indexOf('createHerdWatchdog({', iCall);
  assert.ok(iHerd > 0, 'mgmt 状态建在 createHerdWatchdog 之前（onHeartbeat 依赖它）');
  const iHb = src.indexOf('onHeartbeat:', iHerd);
  assert.ok(iHb > 0 && iHb < src.indexOf('herd.start()', iHerd), 'onHeartbeat 挂在 herd deps（与看门狗同拍，⛔ 不新造定时器）');
  assert.ok(src.slice(iHb, iHb + 240).includes('mgmtRoundTick'), 'onHeartbeat 里带起 mgmtRoundTick');
  assert.ok(src.slice(iHb, iHb + 240).includes('fireMgmtRound(runtime'), 'fire 注入真 runtime（prompt+waitForTurn 通路）');
  assert.ok(
    src.includes('herd?.stop(); // 看门狗定时器 + .herd.lock + 管理回合拍子'),
    'dispose 卸载：管理回合随 herd 停（无自有定时器/锁）',
  );
  ok('⑧ 接线防回归：import+调用点齐、master 门内、onHeartbeat 同拍、dispose 随 herd 停');
}

console.log(`\nALL PASS — ${passed} 组断言全绿（任务 #34 判据全覆盖）`);

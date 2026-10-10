// test-file-reassign.mjs — #66 换人钩子（文件 mtime 判据）回归测试
//
// 跑法：node test-file-reassign.mjs
//
// 覆盖（与任务判据一一对应）：
//   ① 合成旧 mtime 的在飞行 → 必须翻「待领取」+ 改派队列最短小工（平手 001→004）+ 结论列批注 + 播报一条
//   ② mtime 新鲜（文件有改动 / 距首见 <10 分钟）→ 必须不动
//   ③ 反向验证：判据改回 30 分钟 → 同场景必须红（不翻）
//   ④ 首见只记时不判龄；离开「进行中」清快照；30 分钟唤醒门（<30 分钟不跑）
//   ⑤ 描述里认不出目标文件的行不判（防无判据误翻）；目标文件不存在记 0 = 视同零改动 → 照翻
//   ⑥ 接线在位：watchWorkerHerd 每拍带起 heartbeatFileReassign，原 herdTick 不丢
//
// 纯切片直驱：bot.js 是 CJS import 不动，照 test-selfwake 同款 indexOf 切块 +
// data: URL 模块装载；statSync / 任务表读写全部打桩，零真 fs、零网络。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const BOT = '/Users/tcm/DSH/BOT';
const bot = readFileSync(`${BOT}/bot.js`, 'utf8');
const pkg = JSON.parse(readFileSync(`${BOT}/package.json`, 'utf8'));

const MIN = 60 * 1000;
const T0 = Date.now(); // 合成时钟基准
/** 排空微任务：播报是 fire-and-forget 的 Promise 派发，断言前要等它落地。 */
const drain = () => new Promise((r) => setImmediate(r));

// ── 切块 ──────────────────────────────────────────────────────────────
const helpersStart = bot.indexOf('/** 队列最短选择');
const hookStart = bot.indexOf('// ── 换人钩子（任务 #66');
const heartbeatStart = bot.indexOf('/** 心跳入口：#66 换人钩子');
assert.ok(helpersStart > 0 && hookStart > helpersStart && heartbeatStart > hookStart, '换人钩子切块定位失败');
const helpersChunk = bot.slice(helpersStart, hookStart);
const hookChunk = bot.slice(hookStart, heartbeatStart);

// 接线块（只做结构断言，不装载——里面有 telegram 等运行期依赖）
const wiringStart = bot.indexOf('function watchWorkerHerd');
const wiringEnd = bot.indexOf('async function handleMessage', wiringStart);
assert.ok(wiringStart > 0 && wiringEnd > wiringStart, 'watchWorkerHerd 接线块切片失败');
const wiringChunk = bot.slice(wiringStart, wiringEnd);

/** 装一个钩子 harness：FILE_STALE_MS 可替换（反向验证用）。 */
async function loadHarness({ staleMs = '10 * 60 * 1000' } = {}) {
  const chunk = hookChunk.replace('const FILE_STALE_MS = 10 * 60 * 1000;', `const FILE_STALE_MS = ${staleMs};`);
  assert.ok(chunk.includes(`const FILE_STALE_MS = ${staleMs};`), 'FILE_STALE_MS 替换失败（反向验证基座没搭起来）');
  const src = [
    "const WORKER_NAMES = ['001bot', '002bot', '003bot', '004bot'];",
    "const _ts = () => 'TEST';",
    'const FILES = {};', // 路径 → mtimeMs；没登记 = statSync 抛 ENOENT
    'const statSync = (p) => {',
    '  if (!(p in FILES)) { const e = new Error("ENOENT: " + p); e.code = "ENOENT"; throw e; }',
    '  return { mtimeMs: FILES[p] };',
    '};',
    'let tableText = "";',
    'const stats = { writes: 0, announces: [] };',
    'const readTaskTable = () => tableText;',
    'const writeTaskTable = (t) => { tableText = t; stats.writes += 1; };',
    'const announce = (text) => { stats.announces.push(text); return Promise.resolve(); };',
    helpersChunk,
    chunk,
    'const getTable = () => tableText;',
    'const setTable = (t) => { tableText = t; };',
    'export { fileReassignTick, makeFileHookState, reassignTaskRow, pickLeastBusyWorker,',
    '  extractTaskFilePaths, newestTargetMtime, FILE_STALE_MS, FILE_REASSIGN_INTERVAL_MS,',
    '  FILES, stats, getTable, setTable };',
  ].join('\n');
  return import('data:text/javascript,' + encodeURIComponent(src));
}

const H = await loadHarness();
const R = await loadHarness({ staleMs: '30 * 60 * 1000' }); // 反向验证 harness：判据改回 30 分钟

function makeTable(rows) {
  return ['# 任务表（测试夹具）', '| # | 任务 | 负责 | 状态 | 结论 |', ...rows].join('\n');
}

test('T1 接线在位：watchWorkerHerd 每拍带起换人钩子，原巡检不丢', () => {
  assert.match(wiringChunk, /heartbeatFileReassign\(\);/, '同拍必须带起换人钩子');
  assert.match(wiringChunk, /herdTick\(\);/, '#9 原巡检不能丢');
  assert.match(wiringChunk, /\[herd\] 看门狗心跳正常/, '每拍活体心跳日志不能丢');
  assert.match(bot, /const FILE_REASSIGN_INTERVAL_MS = 30 \* 60 \* 1000;/, '30 分钟唤醒门常量在位');
  assert.match(bot, /const FILE_STALE_MS = 10 \* 60 \* 1000;/, '10 分钟换人判据常量在位');
  assert.equal(pkg.version, '1.0.55', '改 src 必须升版');
});

test('T2 首见只记时不判龄：古老 mtime 第一拍不许翻', async () => {
  const state = H.makeFileHookState();
  H.setTable(makeTable(['| 901 | 改 f1.js 修 bug | 002bot | 进行中 | — |']));
  H.FILES['f1.js'] = T0 - 10 * 60 * MIN; // 十小时前 = 远超 10 分钟
  const verdicts = H.fileReassignTick(state, { readTable: H.getTable, writeTable: (t) => H.setTable(t), announce: () => {} }, T0);
  await drain();
  assert.deepEqual(verdicts, [], '首见只记时，不许出结论');
  assert.match(H.getTable(), /\| 901 \|.*\| 002bot \| 进行中 \|/, '行必须原样');
  assert.equal(state.progress.get('901').mtimeMs, T0 - 10 * 60 * MIN, '快照必须记下 mtime');
});

test('T3 旧 mtime 在飞行 → 翻待领取 + 改派队列最短 + 批注 + 播报（判据①）', async () => {
  const state = H.makeFileHookState();
  H.setTable(makeTable([
    '| 901 | 改 f1.js 修 bug | 002bot | 进行中 | — |',
    '| 902 | 改 f2.js 补测试 | 001bot | 进行中 | — |',
  ]));
  H.FILES['f1.js'] = T0 - 60 * MIN;
  H.FILES['f2.js'] = T0 - 60 * MIN;
  H.fileReassignTick(state, { readTable: H.getTable, writeTable: (t) => H.setTable(t), announce: () => {} }, T0);
  const verdicts = H.fileReassignTick(state, { readTable: H.getTable, writeTable: (t) => H.setTable(t), announce: (text) => H.stats.announces.push(text) }, T0 + 31 * MIN);
  await drain();
  assert.equal(verdicts.length, 2, `两条在飞行都得翻（实际 ${verdicts.length}）`);
  const row901 = H.getTable().split('\n').find((l) => l.startsWith('| 901 '));
  const row902 = H.getTable().split('\n').find((l) => l.startsWith('| 902 '));
  // 901 处置时 001bot 名下还有 902 → 队列最短是 003bot（平手 003<004）；不回流 002bot
  assert.match(row901, /\| 003bot \| 待领取 \|/, '901 必须翻待领取且改派 003bot');
  // 901 已让出后 002bot 空了 → 902 改派 002bot；不回流 001bot
  assert.match(row902, /\| 002bot \| 待领取 \|/, '902 必须翻待领取且改派 002bot');
  assert.match(row901, /⏰ 换人钩子（\d\d-\d\d \d\d:\d\d）：文件10分钟零改动，改派 003bot/, '结论列批注格式');
  assert.match(row901, /🐕 看门狗改派/, '共用翻牌逻辑的批注头在位');
  assert.equal(state.progress.has('901'), false, '处置完清快照，下轮重新首见');
  assert.equal(H.stats.announces.length, 1, '一轮巡检合并一条播报');
  assert.match(H.stats.announces[0], /#901（002bot）/);
  assert.match(H.stats.announces[0], /#902（001bot）/, '播报必须点名谁被判据翻牌');
});

test('T4 mtime 新鲜必须不动（判据②）：文件有改动 / 距首见 <10 分钟', async () => {
  const state = H.makeFileHookState();
  H.setTable(makeTable([
    '| 910 | 改 f3.js 加功能 | 002bot | 进行中 | — |',
    '| 911 | 改 f4.js 收尾 | 003bot | 进行中 | — |',
  ]));
  H.FILES['f3.js'] = T0;
  H.FILES['f4.js'] = T0 - 60 * MIN;
  H.fileReassignTick(state, { readTable: H.getTable, writeTable: (t) => H.setTable(t), announce: () => {} }, T0);
  H.FILES['f3.js'] = T0 + 30 * MIN; // 小工 30 分钟里真在动文件
  state.progress.set('911', { files: ['f4.js'], mtimeMs: T0 - 60 * MIN, since: T0 + 28 * MIN }); // 911 刚被接手 3 分钟
  const verdicts = H.fileReassignTick(state, { readTable: H.getTable, writeTable: (t) => H.setTable(t), announce: () => {} }, T0 + 31 * MIN);
  await drain();
  assert.deepEqual(verdicts, [], '新鲜的都不许翻');
  const table = H.getTable();
  assert.match(table, /\| 910 \|.*\| 002bot \| 进行中 \|/, '910 文件在动必须原地不动');
  assert.match(table, /\| 911 \|.*\| 003bot \| 进行中 \|/, '911 未满 10 分钟必须不动');
});

test('T5 反向验证：判据改回 30 分钟，同场景必须红（不翻）', async () => {
  const seed = (harness, state) => {
    harness.setTable(makeTable(['| 920 | 改 f5.js 打磨 | 004bot | 进行中 | — |']));
    harness.FILES['f5.js'] = T0 - 60 * MIN;
    // 首见定在 T0+16min：到 T0+31min 那拍，距首见 15 分钟 —— 落在 10/30 判据分界区
    state.progress.set('920', { files: ['f5.js'], mtimeMs: T0 - 60 * MIN, since: T0 + 16 * MIN });
    state.lastRun = T0; // 过 30 分钟唤醒门，只让 10/30 分钟判据说话
  };
  const deps = (harness) => ({ readTable: harness.getTable, writeTable: (t) => harness.setTable(t), announce: () => {} });
  const state10 = H.makeFileHookState();
  seed(H, state10);
  const v10 = H.fileReassignTick(state10, deps(H), T0 + 31 * MIN);
  const state30 = R.makeFileHookState();
  seed(R, state30);
  const v30 = R.fileReassignTick(state30, deps(R), T0 + 31 * MIN);
  await drain();
  assert.equal(v10.length, 1, '10 分钟判据：15 分钟零改动必须翻');
  assert.match(H.getTable(), /\| 001bot \| 待领取 \|/, '10 分钟判据：翻牌+改派落表');
  assert.deepEqual(v30, [], '30 分钟判据（旧判据）：15 分钟零改动必须不翻（红）');
  assert.match(R.getTable(), /\| 004bot \| 进行中 \|/, '旧判据下行必须原地不动');
});

test('T6 离开「进行中」→ 清快照；无文件路径的行不判', async () => {
  const state = H.makeFileHookState();
  state.progress.set('930', { files: ['f9.js'], mtimeMs: T0, since: T0 });
  H.setTable(makeTable([
    '| 930 | 改 f9.js | 002bot | 待验收 | — |', // 已离开进行中
    '| 940 | 开会讨论周报分工 | 003bot | 进行中 | — |', // 描述里没有目标文件
  ]));
  H.fileReassignTick(state, { readTable: H.getTable, writeTable: (t) => H.setTable(t), announce: () => {} }, T0 + 31 * MIN);
  await drain();
  assert.equal(state.progress.has('930'), false, '离开进行中必须清快照');
  assert.equal(state.progress.has('940'), false, '无判据的行不许进快照');
  assert.match(H.getTable(), /\| 940 \|.*\| 003bot \| 进行中 \|/, '无文件路径的行不许被 mtime 钩子翻');
});

test('T7 目标文件不存在记 0 = 视同零改动 → 照翻（说好的约定）', async () => {
  const state = H.makeFileHookState();
  H.setTable(makeTable(['| 950 | 新建 ghost/missing.js | 002bot | 进行中 | — |']));
  H.fileReassignTick(state, { readTable: H.getTable, writeTable: (t) => H.setTable(t), announce: () => {} }, T0); // 首见记 0
  const verdicts = H.fileReassignTick(state, { readTable: H.getTable, writeTable: (t) => H.setTable(t), announce: () => {} }, T0 + 31 * MIN);
  await drain();
  assert.equal(verdicts.length, 1, '文件一直不存在=零改动，照老板令换人');
  assert.match(H.getTable(), /\| 001bot \| 待领取 \|/, '照常翻牌改派');
});

test('T8 30 分钟唤醒门：距上轮 <30 分钟不跑，≥30 分钟才跑', async () => {
  const state = H.makeFileHookState();
  H.setTable(makeTable(['| 960 | 改 f6.js | 002bot | 进行中 | — |']));
  H.FILES['f6.js'] = T0 - 60 * MIN;
  const deps = { readTable: H.getTable, writeTable: (t) => H.setTable(t), announce: () => {} };
  H.fileReassignTick(state, deps, T0); // 首轮（lastRun 0 → 立即跑），首见
  const writesAfterFirst = H.stats.writes;
  const early = H.fileReassignTick(state, deps, T0 + 29 * MIN);
  assert.deepEqual(early, [], '<30 分钟不许跑');
  assert.equal(H.stats.writes, writesAfterFirst, '<30 分钟不许落表');
  const late = H.fileReassignTick(state, deps, T0 + 31 * MIN);
  await drain();
  assert.equal(late.length, 1, '≥30 分钟跑一轮并按判据处置');
});

test('T9 路径 token 头尾引号括号剥除 + 提取判据', () => {
  assert.deepEqual(H.extractTaskFilePaths('改 「modules/crm/a.js」 和 bot.js 收尾'), ['modules/crm/a.js', 'bot.js']);
  assert.deepEqual(H.extractTaskFilePaths('开会讨论，不碰文件'), []);
  assert.deepEqual(H.extractTaskFilePaths(undefined), []);
});

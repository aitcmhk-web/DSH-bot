// 任务 #45 回归测试（2026-10-09）：主 bot 30 分钟自醒（#34 的 bot.js 真身接线）+ herd.js 拿锁哑火口修复。
//
// 三组判据：
//   A. src/herd.js 拿锁韧性（真模块直驱，/tmp 沙箱，绝不真跑 launchctl —— 测试 root 里
//      四个小工的 pidfile/日志全部指向本进程且新鲜 = 健康，herdTick 永不产出判死结论）：
//      A1 无锁 → 正常接手；A2 【反向④】人为残锁（死 pid 旧心跳）→ 显式「失联残留」日志 + 接管；
//      A3 持有者活着心跳新鲜（真活 pid=sleep 子进程）→ 从属拍不接管，onHeartbeat 照跑；
//      A4 持有者活着心跳停超 15 分钟 → 半瘫接管；A5 【哑火口】.herd.lock 变目录（EISDIR）→
//      start 照挂拍子、tick 每拍显式日志不静默、错误清除后下拍自动恢复选主（旧版永久停摆）。
//   B. bot.js 接线静态断言（测真实源码文本，非复刻）：import 在、拍子挂了、提示词没复制第二份。
//   C. heartbeatMgmtRound 行为断言（bot.js 真实切片 + 真 src/mgmt-round.js 直驱）：
//      未到 30 分钟静默；到点投递且提示词 = MGMT_ROUND_PROMPT 一字不改；不堆叠；
//      无处投递显式报错不卡死、恢复后能再触发。
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const BOT = '/Users/tcm/DSH/BOT';
const WORKERS = ['001bot', '002bot', '003bot', '004bot'];
const { claimHerdLock, createHerdWatchdog } = await import(`${BOT}/src/herd.js`);
const { MGMT_ROUND_PROMPT } = await import(`${BOT}/src/mgmt-round.js`);

const scratchDirs = [];
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'dsh-selfwake-'));
  scratchDirs.push(d);
  return d;
}
// 四个小工全部「健康」：pidfile=本进程（kill -0 活）+ 日志 mtime 新鲜 → herdTick 零结论零 kick。
function makeHealthyRoot(dir) {
  for (const n of WORKERS) {
    writeFileSync(join(dir, `.bot.pid-${n}`), String(process.pid));
    writeFileSync(join(dir, `bot-${n}.log`), 'ok\n');
  }
}

// ── A 组：herd.js 拿锁韧性 ────────────────────────────────────────────────
function makeHerd(dir, beats) {
  const seen = { logs: [], errs: [] };
  const herd = createHerdWatchdog({
    root: dir,
    lockPath: join(dir, '.herd.lock'),
    readTable: () => null,
    writeTable: () => {},
    announce: async () => {},
    log: (m) => seen.logs.push(m),
    error: (m) => seen.errs.push(m),
    onHeartbeat: () => beats.push(Date.now()),
  });
  return { herd, seen };
}

test('A1 无锁：start 正常接手并落显式日志', () => {
  const dir = freshDir();
  makeHealthyRoot(dir);
  const { herd, seen } = makeHerd(dir, []);
  try {
    assert.equal(herd.start(), true);
    assert.ok(seen.logs.some((l) => l.includes('接手小工看门狗')), `应落接手日志，实际: ${seen.logs}`);
    assert.equal(JSON.parse(readFileSync(join(dir, '.herd.lock'), 'utf8')).pid, process.pid);
  } finally {
    herd.stop();
  }
});

test('A2 【反向④】人为制造残锁（死 pid + 过期心跳）→ 显式报错接管，绝不哑火', () => {
  const dir = freshDir();
  makeHealthyRoot(dir);
  const lockPath = join(dir, '.herd.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 4000000, heartbeat: Date.now() - 20 * 60 * 1000 }));
  const { herd, seen } = makeHerd(dir, []);
  try {
    assert.equal(herd.start(), true, '死持有者的残锁必须被接管而不是让位');
    assert.ok(seen.logs.some((l) => l.includes('失联残留') && l.includes('4000000')), `应显式报告残锁来源，实际: ${seen.logs}`);
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid, '接管后锁应归本进程');
  } finally {
    herd.stop();
  }
});

test('A3 持有者活着且心跳新鲜（真活 pid）：从属拍不接管，onHeartbeat 照跑', () => {
  const dir = freshDir();
  makeHealthyRoot(dir);
  const lockPath = join(dir, '.herd.lock');
  const sleeper = spawn('sleep', ['30']); // 一个真活的他者 pid
  writeFileSync(lockPath, JSON.stringify({ pid: sleeper.pid, heartbeat: Date.now() }));
  const beats = [];
  const { herd, seen } = makeHerd(dir, beats);
  try {
    assert.equal(herd.start(), false, '别人健康持锁 → 本实例转从属，不当主');
    assert.ok(seen.logs.some((l) => l.includes('由别的实例看护')), `从属必须落日志，实际: ${seen.logs}`);
    herd.tick();
    assert.equal(beats.length, 1, '从属拍也要跑附带任务（管理回合跟着拍走）');
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, sleeper.pid, '从属拍不许改写别人的锁');
  } finally {
    herd.stop();
    sleeper.kill();
  }
});

test('A4 持有者活着但心跳停超 15 分钟（半瘫）→ 接管并显式播报', () => {
  const dir = freshDir();
  makeHealthyRoot(dir);
  const lockPath = join(dir, '.herd.lock');
  const sleeper = spawn('sleep', ['30']);
  writeFileSync(lockPath, JSON.stringify({ pid: sleeper.pid, heartbeat: Date.now() - 16 * 60 * 1000 }));
  const { herd, seen } = makeHerd(dir, []);
  try {
    assert.equal(herd.start(), true, '半瘫持有者必须被接管');
    assert.ok(seen.logs.some((l) => l.includes('失联残留')), `半瘫接管必须有显式日志，实际: ${seen.logs}`);
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid, '接管后锁归本进程');
  } finally {
    herd.stop();
    sleeper.kill();
  }
});

test('A5 【哑火口】.herd.lock 不可写（目录占位）→ 每拍显式日志不静默，错误清除后下拍自起', () => {
  const dir = freshDir();
  makeHealthyRoot(dir);
  const lockPath = join(dir, '.herd.lock');
  mkdirSync(lockPath); // 人为让 writeFileSync(wx) 报 EISDIR
  const beats = [];
  const { herd, seen } = makeHerd(dir, beats);
  try {
    assert.equal(herd.start(), false, '错误期选不上主');
    assert.ok(seen.errs.some((l) => l.includes('不可用') && l.includes('照挂拍子')), `start 必须显式报错且声明拍子照挂，实际: ${seen.errs}`);
    herd.tick();
    herd.tick();
    assert.equal(beats.length, 0, '错误期不跑附带任务（fail-closed）');
    assert.equal(seen.errs.filter((l) => l.includes('本拍跳过巡检与附带任务')).length, 2, `错误期每拍一条显式日志，实际: ${seen.errs}`);
    rmSync(lockPath, { recursive: true }); // 错误清除
    herd.tick();
    assert.equal(beats.length, 1, '错误清除后下一拍必须自动恢复（旧版会永久哑火）');
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid, '恢复后锁归本进程');
  } finally {
    herd.stop();
  }
});

// ── B 组：bot.js 接线静态断言（真实源码文本）─────────────────────────────
const bot = readFileSync(`${BOT}/bot.js`, 'utf8');
const herdSrc = readFileSync(`${BOT}/src/herd.js`, 'utf8');
const pkg = JSON.parse(readFileSync(`${BOT}/package.json`, 'utf8'));

test('B1 版本号已升（改 src/ 必须升版，第 23 条）', () => {
  // 跟随当前版本走（#45 起每次升版同步本行；#46/#48 漏更导致红过，#49 修到 1.0.52）。
  assert.equal(pkg.version, '1.0.52');
});

test('B2 bot.js 已 import mgmt-round 唯一权威源', () => {
  assert.match(bot, /import \{ makeMgmtState, mgmtRoundTick, MGMT_ROUND_PROMPT \} from '\.\/src\/mgmt-round\.js';/);
});

test('B3 拍子接线：watchWorkerHerd 每拍落 [herd] 心跳行 + 带起管理回合', () => {
  const start = bot.indexOf('function watchWorkerHerd');
  const end = bot.indexOf('async function handleMessage', start);
  const body = bot.slice(start, end);
  assert.match(body, /\[herd\] 看门狗心跳正常/, '每拍必须有活体心跳日志行');
  assert.match(body, /heartbeatMgmtRound\(\);/, '同拍必须带起管理回合判定');
  assert.match(body, /herdTick\(\);/, '原巡检不能丢');
});

test('B4 提示词没有第二份：固定提示词只活在 src/mgmt-round.js', () => {
  const marker = '例行管理回合：①读任务表';
  assert.ok(MGMT_ROUND_PROMPT.includes(marker), '权威源必须含固定提示词');
  assert.ok(!bot.includes(marker), 'bot.js 只许 import，不许复制提示词文本');
  assert.match(bot, /MGMT_ROUND_PROMPT, \/\/ 固定提示词/);
});

test('B5 herd.js 哑火口修复在源码里（不再 stop()、start 照挂拍子）', () => {
  assert.ok(!herdSrc.includes('停止巡检与附带任务'), '旧的 stop() 哑火路径必须消失');
  assert.match(herdSrc, /照挂拍子，每拍重试选主/);
  assert.match(herdSrc, /本拍跳过巡检与附带任务，下拍重试/);
});

// ── C 组：heartbeatMgmtRound 行为（bot.js 真实切片 + 真 mgmt-round 直驱）────
const wiringStart = bot.indexOf('const mgmtState = makeMgmtState();');
const wiringEnd = bot.indexOf('// ---- 协作任务表轮询', wiringStart);
assert.ok(wiringStart > 0 && wiringEnd > wiringStart, 'bot.js 管理回合接线块切片失败');
const wiringChunk = bot.slice(wiringStart, wiringEnd);

const harness = await import(
  'data:text/javascript,' +
    encodeURIComponent(`
import { makeMgmtState, mgmtRoundTick, MGMT_ROUND_PROMPT } from 'file://${BOT}/src/mgmt-round.js';
const calls = { submit: [] };
const GROUP_MODE = { groupId: '-5334440553' };
const state = { ownerUserId: 7934872283 };
const groupChatIdFromTable = () => GROUP_MODE.groupId;
const _ts = () => 'TEST';
const submitTurn = (chatId, blocks) => { calls.submit.push({ chatId, blocks }); };
${wiringChunk}
export { calls, GROUP_MODE, state, mgmtState, heartbeatMgmtRound };
`)
);
const heartbeatMgmtRound = harness.heartbeatMgmtRound;

// 投递是异步微任务，console 捕获窗必须盖住 flush 之后的日志，否则抓不到 [mgmt-round] 行。
async function withConsole(fn) {
  const logs = [];
  const errs = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  try {
    await fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally {
    console.log = ol;
    console.error = oe;
  }
  return { logs, errs };
}

test('C1 启动后 30 分钟内：静默不触发', async () => {
  harness.mgmtState.lastFiredAt = Date.now(); // 刚启动
  harness.calls.submit.length = 0;
  const { logs } = await withConsole(async () => heartbeatMgmtRound());
  assert.equal(harness.calls.submit.length, 0, '未到拍不许投递');
  assert.ok(!logs.join('\n').includes('管理回合触发'), '未到拍必须静默');
});

test('C2 到点触发：投递给协作群、提示词一字不改、状态推进', async () => {
  harness.mgmtState.lastFiredAt = Date.now() - 31 * 60 * 1000;
  harness.calls.submit.length = 0;
  const { logs } = await withConsole(async () => heartbeatMgmtRound());
  assert.equal(harness.calls.submit.length, 1, '到点必须恰投一次');
  const { chatId, blocks } = harness.calls.submit[0];
  assert.equal(chatId, -5334440553, '投递目标是协作群');
  const text = blocks[0].text;
  assert.ok(text.includes('（系统触发，无需回复此段）'), '必须是系统触发声明');
  assert.ok(text.includes(MGMT_ROUND_PROMPT), '提示词必须一字不改（权威源全文内嵌）');
  assert.ok(logs.join('\n').includes('[mgmt-round] 管理回合触发'), '必须落 [mgmt-round] 心跳');
  assert.equal(harness.mgmtState.busy, false, '投递完成后 busy 必须解锁');
});

test('C3 30 分钟内不堆叠（判距防重复）', async () => {
  harness.calls.submit.length = 0;
  await withConsole(async () => heartbeatMgmtRound()); // 刚触发过，未到 30 分钟
  await withConsole(async () => heartbeatMgmtRound());
  assert.equal(harness.calls.submit.length, 0, '判距内不许再投');
});

test('C4 无处投递（群 id 与 owner 均缺）→ 显式报错且不卡死，恢复后能再触发', async () => {
  harness.mgmtState.lastFiredAt = Date.now() - 31 * 60 * 1000;
  const keepGroup = harness.GROUP_MODE.groupId;
  const keepOwner = harness.state.ownerUserId;
  harness.GROUP_MODE.groupId = null;
  harness.state.ownerUserId = null;
  try {
    const { errs } = await withConsole(async () => heartbeatMgmtRound());
    assert.equal(harness.calls.submit.length, 0);
    assert.ok(errs.join('\n').includes('管理回合失败'), `无处投递必须显式报错，实际: ${errs}`);
    assert.equal(harness.mgmtState.busy, false, '失败也必须解锁，不许永久卡死');
    // 恢复目标后，下一拍必须能再触发（一次失败不许把自醒打死）
    harness.GROUP_MODE.groupId = keepGroup;
    harness.mgmtState.lastFiredAt = Date.now() - 31 * 60 * 1000;
    await withConsole(async () => heartbeatMgmtRound());
    assert.equal(harness.calls.submit.length, 1, '恢复后必须能再次触发');
  } finally {
    harness.GROUP_MODE.groupId = keepGroup;
    harness.state.ownerUserId = keepOwner;
  }
});

process.on('exit', () => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

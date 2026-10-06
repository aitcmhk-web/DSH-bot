// 任务表 watcher 纯逻辑测试：从 bot.js / src/index.js 抽**真实函数文本**跑断言。
// ⚠️ 测的是源文件里的原代码，不是复刻算法（防「测试复制算法=没测」）。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import assert from 'node:assert';

const BOT = '/Users/tcm/DSH/BOT';
const TMP = `/tmp/dsh-tasktable-test-${process.pid}`;
mkdirSync(TMP, { recursive: true });
if (!process.env.KEEP) process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

// ---------- 抽 bot.js 侧 ----------
const bot = readFileSync(`${BOT}/bot.js`, 'utf8');
const bStart = bot.indexOf('const TASK_TABLE_PATH');
const bEnd = bot.indexOf('async function handleMessage');
assert.ok(bStart > 0 && bEnd > bStart, 'bot.js 切片失败');
const bChunk = bot.slice(bStart, bEnd);

// ---------- 抽 src/index.js 侧 ----------
const idx = readFileSync(`${BOT}/src/index.js`, 'utf8');
const iStart = idx.indexOf('const TASK_TABLE_PATH = process.env.DSH_TASK_TABLE');
const iEnd = idx.indexOf('  // 卸载', iStart);
assert.ok(iStart > 0 && iEnd > iStart, 'index.js 切片失败');
// 去掉两空格缩进，转成顶层可执行文本
const iChunk = idx.slice(iStart, iEnd).split('\n').map((l) => l.replace(/^  /, '')).join('\n');

// ---------- 公共 stub ----------
const fsStub = `
const __fs = await import('node:fs');
const readFileSync = (...a) => __fs.readFileSync(...a);
const writeFileSync = (...a) => __fs.writeFileSync(...a);
const renameSync = (...a) => __fs.renameSync(...a);
const join = (...a) => __path.join(...a);
const assert = (await import('node:assert')).strict;
const console2 = console;
`;
const pathImport = `import { join as __join } from 'node:path';\nconst __path = { join: __join };\n`;

// ---------- bot.js 侧测试 ----------
const bTest = `
// ---- bot.js 侧：验收 watcher 的纯函数 ----
const APP_DIR = ${JSON.stringify(TMP)};
const state = { ownerUserId: 42 };
let submitted = [];
const submitTurn = (chatId, blocks) => { submitted.push({ chatId, blocks }); };
let intervalFn = null;
const setInterval = (fn) => { intervalFn = fn; return 7; };
const _ts = () => 'T';
const console = { log: () => {}, error: (...a) => console2.error(...a) };


${bChunk}
watchTaskTable(); // bot.js 里这行在启动段，切片里补上

// 1) 文件不存在 → null
assert.equal(readTaskTable(), null);
assert.equal(findTaskRow('x', '待领取'), null);

// 2) 命中「待领取」行；模板行（no=—、状态=—）不误命中
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# 任务表',
  '> 协作群 chat id:（占位）',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| — | （模板） | 插件版 | — | — |',
  '| 3 | 修 asr 超时 | 插件版 | 待领取 | — |',
].join('\\n'));
let row = findTaskRow(readTaskTable(), '待领取');
assert.ok(row, '应命中待领取');
assert.equal(row.no, '3');
assert.equal(row.task, '修 asr 超时');

// 3) 任务文本里含「待验收」但状态列是「进行中」→ 找「待验收」不命中（反向验证）
__fs.writeFileSync(TASK_TABLE_PATH, readTaskTable().replace('修 asr 超时', '修「待验收」卡死'));
assert.equal(findTaskRow(readTaskTable(), '待验收'), null);

// 4) setTaskStatus 按列改，任务文本不被动
row = findTaskRow(readTaskTable(), '待领取');
setTaskStatus(row, '进行中');
assert.match(readTaskTable(), /\\| 3 \\| 修「待验收」卡死 \\| 插件版 \\| 进行中 \\|/);
assert.equal(findTaskRow(readTaskTable(), '待领取'), null, '改完不再命中');

// 5) 行被别人动过 → 放弃不写（防覆盖）
row = findTaskRow(readTaskTable(), '进行中');
const before = readTaskTable();
__fs.writeFileSync(TASK_TABLE_PATH, before.replace('修「待验收」卡死', '别人改过的任务'));
setTaskStatus(row, '验收中');
assert.match(readTaskTable(), /别人改过的任务/, '行变了必须放弃');
assert.doesNotMatch(readTaskTable(), /验收中/, '不许覆盖别人的行');

// 6) 群 id 回填幂等 + 读取
assert.equal(groupChatIdFromTable(), null);
registerGroupChat(-100999);
assert.equal(groupChatIdFromTable(), '-100999');
const snap = readTaskTable();
registerGroupChat(-100999);
assert.equal(readTaskTable(), snap, '重复回填必须零写入');
assert.equal(groupChatIdFromTable(), '-100999');

// 7) watchTaskTable 一轮：待验收 → 占位 + submitTurn 到协作群
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 5 | 加导出功能 | 插件版 | 待验收 | — |',
].join('\\n'));
intervalFn();
assert.equal(submitted.length, 1, '应触发一轮验收');
assert.equal(submitted[0].chatId, -100888);
assert.match(submitted[0].blocks[0].text, /#5/);
assert.match(submitted[0].blocks[0].text, /加导出功能/);
assert.match(readTaskTable(), /\\| 5 \\| 加导出功能 \\| 插件版 \\| 验收中 \\|/, '触发前先占位');
intervalFn();
assert.equal(submitted.length, 1, '占位后不得重复触发');

// 8) 无群 id → 兜底私聊 owner
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id:（占位）',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 6 | 另一个活 | 插件版 | 待验收 | — |',
].join('\\n'));
intervalFn();
assert.equal(submitted[1].chatId, 42, '无群 id 应回退 owner 私聊');
console2.log('bot.js 侧 8 组断言全过');
`;

// ---------- index.js 侧测试 ----------
const iTest = `
// ---- src/index.js 侧：领活 watcher ----
const state = { stopped: false, ownerUserId: 7 };
let enqueued = [];
const enqueue = (key, task) => { enqueued.push({ key, task }); };
let prompted = [];
const promptFromHub = async (msg) => { prompted.push(msg); return { ok: true }; };
const log = () => {};
const error = (...a) => console2.error(...a);
let intervalFn = null;
const setInterval = (fn) => { intervalFn = fn; return 8; };

process.env.DSH_TASK_TABLE = __path.join(${JSON.stringify(TMP)}, '插件侧任务表.md');
const TASK_TABLE = process.env.DSH_TASK_TABLE;

${iChunk}

// 1) 无表 → 静默
intervalFn();
assert.equal(enqueued.length, 0);

// 2) 待领取 → 占位「进行中」+ enqueue(tg:群id) + prompt 带任务文本和红线
__fs.writeFileSync(TASK_TABLE, [
  '# t',
  '> 协作群 chat id: -100777',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 9 | 给导出加缓存 | 插件版 | 待领取 | — |',
].join('\\n'));
intervalFn();
assert.equal(enqueued.length, 1, '应领活');
assert.equal(enqueued[0].key, 'tg:-100777');
await enqueued[0].task();
const msg = prompted[0];
assert.equal(msg.source, 'tg');
assert.equal(msg.chatId, -100777);
assert.match(msg.text, /#9/);
assert.match(msg.text, /给导出加缓存/);
assert.match(msg.text, /git 提交\\/推送\\/发版由主 bot 验收/, '红线必须在 prompt 里');
assert.match(__fs.readFileSync(TASK_TABLE, 'utf8'), /\\| 9 \\| 给导出加缓存 \\| 插件版 \\| 进行中 \\|/);
intervalFn();
assert.equal(enqueued.length, 1, '占位后不得重复领');

// 3) 无群 id → 兜底 owner 私聊
__fs.writeFileSync(TASK_TABLE, [
  '# t',
  '> 协作群 chat id:（占位）',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 10 | 又一个活 | 插件版 | 待领取 | — |',
].join('\\n'));
intervalFn();
await enqueued[1].task();
assert.equal(prompted[1].chatId, 7);
console2.log('index.js 侧 3 组断言全过');
`;

const script = `${pathImport}${fsStub}\nconst __run = async () => {\n{\n${bTest}\n}\n{\n${iTest}\n}\n};\nawait __run();\n`;
const testFile = `${TMP}/run.mjs`;
writeFileSync(testFile, script);
await import(testFile);
console.log('ALL PASS');

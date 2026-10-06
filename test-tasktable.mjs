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
const statSync = (...a) => __fs.statSync(...a);
const join = (...a) => __path.join(...a);
const assert = (await import('node:assert')).strict;
const console2 = console;
`;
const pathImport = `import { join as __join } from 'node:path';\nconst __path = { join: __join };\n`;

// ---------- bot.js 侧测试 ----------
const bTest = `
// ---- bot.js 侧：验收 watcher 的纯函数 ----
const APP_DIR = ${JSON.stringify(TMP)};
const BOT_ROLE = 'master'; // 看门狗块顶层引用（worker 才开心跳）；测试按 master 走
const INSTANCE = '002bot'; // worker 领活身份（#10 任务纯净测试用）
process.env.DSH_PEER_ROOT = APP_DIR; // #11 对端路径指向测试目录（防碰真 dshbot）
const state = { ownerUserId: 42 };
let submitted = [];
const events = []; // 顺序账（#10）：reset / turn 谁先谁后
const submitTurn = (chatId, blocks) => { submitted.push({ chatId, blocks }); events.push(['turn', chatId]); };
const saveState = () => {};
const resetSession = (chatId) => { events.push(['reset', chatId]); };
let intervalFn = null;
const setInterval = (fn) => { intervalFn = fn; return 7; };
const _ts = () => 'T';
const console = { log: () => {}, error: (...a) => console2.error(...a) };
// 看门狗公告桩（sendRich，门六：广播路径不许裸 sendMessage）
const telegram = {
  sent: [],
  async sendRich(chatId, text, extra = {}) { this.sent.push({ chatId, text, extra }); return { ok: true }; },
};


${bChunk}
watchTaskTable(); // bot.js 里这行在启动段，切片里补上

// 1) 文件不存在 → null
assert.equal(readTaskTable(), null);
assert.equal(findTaskRow('x', '待领取'), null);

// 2) 命中「待领取」行；模板行（no=—、状态=—）不误命中
// （owner 用真实 worker 名：2026-10-06 多开改造后 bot.js 侧只认 001-004bot，
//   插件版的领活走 src/index.js 自己的 watcher，见下面 index.js 侧测试）
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# 任务表',
  '> 协作群 chat id:（占位）',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| — | （模板） | 插件版 | — | — |',
  '| 3 | 修 asr 超时 | 001bot | 待领取 | — |',
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
assert.match(readTaskTable(), /\\| 3 \\| 修「待验收」卡死 \\| 001bot \\| 进行中 \\|/);
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
  '| 5 | 加导出功能 | 001bot | 待验收 | — |',
].join('\\n'));
intervalFn();
assert.equal(submitted.length, 1, '应触发一轮验收');
assert.equal(submitted[0].chatId, -100888);
assert.match(submitted[0].blocks[0].text, /#5/);
assert.match(submitted[0].blocks[0].text, /加导出功能/);
assert.match(readTaskTable(), /\\| 5 \\| 加导出功能 \\| 001bot \\| 验收中 \\|/, '触发前先占位');
intervalFn();
assert.equal(submitted.length, 1, '占位后不得重复触发');

// 8) 无群 id → 兜底私聊 owner
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id:（占位）',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 6 | 另一个活 | 001bot | 待验收 | — |',
].join('\\n'));
intervalFn();
assert.equal(submitted[1].chatId, 42, '无群 id 应回退 owner 私聊');

// 9) 看门狗（#9）：存活 + 进度。全部用合成 pidfile / 摸日志 mtime / 假时间戳。
// 9a 健康小工必须不报（防误报锁死）：pid=本测试进程（kill -0 必活）+ 日志新鲜（=心跳刚写过）
for (const name of WORKER_NAMES) {
  __fs.writeFileSync(join(APP_DIR, \`.bot.pid-\${name}\`), String(process.pid));
  __fs.writeFileSync(join(APP_DIR, \`bot-\${name}.log\`), '[hb] 心跳正常（测试桩）\\n');
}
const sentBefore = telegram.sent.length;
herdTick();
assert.equal(telegram.sent.length, sentBefore, '四个小工全健康 → 不许公告');

// 9b 假活必报（004bot 实案形状）：pid 活 + 日志摸旧 20 分钟；名下进行中的行自动改派
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 20 | 假活名下的活 | 001bot | 进行中 | — |',
].join('\\n'));
const stale = new Date(Date.now() - 20 * 60 * 1000);
__fs.utimesSync(join(APP_DIR, 'bot-001bot.log'), stale, stale);
herdTick();
assert.equal(telegram.sent.length, sentBefore + 1, '日志停摆必须公告');
assert.match(telegram.sent[telegram.sent.length - 1].text, /001bot 判假活/, '判据里要有谁+判定');
assert.match(telegram.sent[telegram.sent.length - 1].text, /20 分钟/, '判据里要有多久没动');
assert.match(telegram.sent[telegram.sent.length - 1].text, /#20/, '公告里要提改派哪行');
assert.match(__fs.readFileSync(TASK_TABLE_PATH, 'utf8'), /\\| 20 \\| 假活名下的活 \\| 001bot \\| 待领取 \\|/, '进行中的行翻「待领取」');
assert.match(__fs.readFileSync(TASK_TABLE_PATH, 'utf8'), /看门狗改派/, '结论列注明改派原因');
herdTick();
assert.equal(telegram.sent.length, sentBefore + 1, '同一小工连续判死不重复公告（边沿触发）');

// 9c pid 真死必报：pidfile 写一个已退出的 pid
const cp = await import('node:child_process');
const deadPid = cp.spawnSync('true').pid;
__fs.writeFileSync(join(APP_DIR, '.bot.pid-003bot'), String(deadPid));
herdTick();
assert.equal(telegram.sent.length, sentBefore + 2, 'pid 死必须公告');
assert.match(telegram.sent[telegram.sent.length - 1].text, /003bot 判死/, '判死公告');

// 9d 进度停摆：进行中 30 分钟纹丝不动 → 公告+改派；刚见到的行不报（快照首见只记时）
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 21 | 停摆的活 | 002bot | 进行中 | — |',
  '| 22 | 待审的活 | 001bot | 待审核 | ✅ 等老板 |',
].join('\\n'));
const t0 = Date.now();
herdTick(t0); // 快照首见：不公告
assert.equal(telegram.sent.length, sentBefore + 2, '首见只记快照');
// 拨钟 31 分钟：存活判据用同一个钟 → 日志 mtime 必须一起摸到新时刻（=心跳照写，
// 这正是健康小工的形状），否则看门狗会先把全组判假活（测试时间旅行要自洽）
const tA = new Date(t0 + 31 * 60 * 1000);
for (const name of WORKER_NAMES) __fs.utimesSync(join(APP_DIR, \`bot-\${name}.log\`), tA, tA);
herdTick(t0 + 31 * 60 * 1000); // 31 分钟后同状态 → 停
assert.equal(telegram.sent.length, sentBefore + 3, '30 分钟纹丝不动必须公告');
assert.match(telegram.sent[telegram.sent.length - 1].text, /#21（002bot）停摆/, '公告点名行+人');
assert.match(__fs.readFileSync(TASK_TABLE_PATH, 'utf8'), /\\| 21 \\| 停摆的活 \\| 002bot \\| 待领取 \\|/, '停摆行翻「待领取」');
assert.doesNotMatch(telegram.sent[telegram.sent.length - 1].text, /#22/, '待审核等老板，不算小工停');

// 9e 待领取卡住 30 分钟 → 公告但不翻状态（本来就没人领）
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 23 | 没人领的活 | 003bot | 待领取 | — |',
].join('\\n'));
const t1 = Date.now();
herdTick(t1);
const t2 = new Date(t1 + 31 * 60 * 1000);
for (const name of WORKER_NAMES) __fs.utimesSync(join(APP_DIR, \`bot-\${name}.log\`), t2, t2);
herdTick(t1 + 31 * 60 * 1000);
assert.equal(telegram.sent.length, sentBefore + 4, '待领取卡住要公告');
assert.match(telegram.sent[telegram.sent.length - 1].text, /#23（003bot）卡住/, '公告点名');
assert.match(__fs.readFileSync(TASK_TABLE_PATH, 'utf8'), /\\| 23 \\| 没人领的活 \\| 003bot \\| 待领取 \\|/, '待领取保持原状态');

// 10) 任务纯净（#10）：①完结→重置会话→再领（新 prompt 不含上一单内容）；②打回 ≥3 次换人
const submittedBefore10 = submitted.length;
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 30 | 第一单活 | 002bot | 待领取 | — |',
].join('\\n'));
watchWorkerTasks();
intervalFn();
assert.equal(submitted.length, submittedBefore10 + 1, '应领到 #30');
assert.match(__fs.readFileSync(TASK_TABLE_PATH, 'utf8'), /\\| 30 \\| 第一单活 \\| 002bot \\| 进行中 \\|/, '领活先占位');
__fs.writeFileSync(TASK_TABLE_PATH, __fs.readFileSync(TASK_TABLE_PATH, 'utf8').replace('| 30 | 第一单活 | 002bot | 进行中 |', '| 30 | 第一单活 | 002bot | 待验收 |'));
const evBeforeReset = events.length;
intervalFn(); // 完结检测：#30 离开进行中 → 重置会话
assert.equal(events.length, evBeforeReset + 1, '任务完结要重置一次会话');
assert.equal(events[events.length - 1][0], 'reset', '最后一条事件是重置');
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 31 | 第二单活 | 002bot | 待领取 | — |',
].join('\\n'));
intervalFn(); // 领 #31：必须发生在重置之后
assert.equal(submitted.length, submittedBefore10 + 2, '应领到 #31');
assert.equal(events[events.length - 2][0], 'reset', '新领活之前必须有重置');
assert.equal(events[events.length - 1][0], 'turn', '重置之后才是新领活');
assert.doesNotMatch(submitted[submittedBefore10 + 1].blocks[0].text, /第一单活/, '新领活 prompt 不含上一单内容');
assert.match(submitted[submittedBefore10 + 1].blocks[0].text, /#31/, '新领活 prompt 是本单任务');

// 10b 打回 ≥3 次 → 换人（队列最短），不回流原小工
__fs.writeFileSync(TASK_TABLE_PATH, __fs.readFileSync(TASK_TABLE_PATH, 'utf8').replace('| 31 | 第二单活 | 002bot | 进行中 |', '| 31 | 第二单活 | 002bot | 待验收 |'));
intervalFn(); // #31 完结 → 重置
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 32 | 三次打回的活 | 002bot | 打回 | ❌ 打回（一）：错；❌ 打回（二）：又错；❌ 打回（三）：还错 |',
  '| 40 | 占队列的活 | 003bot | 进行中 | — |',
  '| 41 | 也占队列 | 001bot | 进行中 | — |',
].join('\\n'));
const submittedBeforeHandoff = submitted.length;
intervalFn(); // 打回 3 次 → 换人给队列最短的 004bot（003bot 有 1 个进行中）
assert.match(__fs.readFileSync(TASK_TABLE_PATH, 'utf8'), /\\| 32 \\| 三次打回的活 \\| 004bot \\| 待领取 \\|/, '换人给队列最短的小工');
assert.match(__fs.readFileSync(TASK_TABLE_PATH, 'utf8'), /3 次打回换人 → 改派 004bot/, '结论列注明换人原因');
assert.equal(submitted.length, submittedBeforeHandoff, '原小工不许再领这行');
intervalFn();
assert.equal(submitted.length, submittedBeforeHandoff, '换人后不再回流');

// 10c 打回 <3 次 → 照常回流自领（#6 行为不回退）
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 33 | 打回一次的活 | 002bot | 打回 | ❌ 打回（验收）：某问题 |',
].join('\\n'));
intervalFn();
assert.equal(submitted.length, submittedBeforeHandoff + 1, '打回 <3 照常回流自领');
assert.match(submitted[submitted.length - 1].blocks[0].text, /#33/, '领的是本行');

// 11) 互为看门狗（#11）：master 查插件版——健康不报；假活必报+拉活；冷却；升级；恢复
const kicks = [];
const kickSpy = () => { kicks.push(1); };
__fs.writeFileSync(join(APP_DIR, '.bot.pid'), String(process.pid)); // 对端 pid=本测试进程（必活）
__fs.writeFileSync(join(APP_DIR, 'bot.log'), '[hb] 心跳正常（对端测试桩）\\n');
const sentBeforePeer = telegram.sent.length;
peerTick(Date.now(), kickSpy);
assert.equal(kicks.length, 0, '对端健康不许拉活');
assert.equal(telegram.sent.length, sentBeforePeer, '对端健康不许公告');
const staleT = new Date(Date.now() - 20 * 60 * 1000);
__fs.utimesSync(join(APP_DIR, 'bot.log'), staleT, staleT); // 对端日志停摆 20 分钟
peerTick(Date.now(), kickSpy);
assert.equal(kicks.length, 1, '对端假活第一次必须拉活');
assert.match(telegram.sent[telegram.sent.length - 1].text, /插件版 判假活/, '公告要有谁+判定');
assert.match(telegram.sent[telegram.sent.length - 1].text, /第 1\\/3 次/, '公告要标第几次拉活');
peerTick(Date.now() + 5 * 60 * 1000, kickSpy);
assert.equal(kicks.length, 1, '冷却期内不重复拉活');
peerTick(Date.now() + 11 * 60 * 1000, kickSpy);
assert.equal(kicks.length, 2, '冷却过后第二次拉活');
peerTick(Date.now() + 22 * 60 * 1000, kickSpy);
assert.equal(kicks.length, 3, '第三次拉活');
peerTick(Date.now() + 33 * 60 * 1000, kickSpy);
assert.equal(kicks.length, 3, '连续 3 次后不再拉');
assert.match(telegram.sent[telegram.sent.length - 1].text, /停止自动重试/, '升级公告找老板');
peerTick(Date.now() + 44 * 60 * 1000, kickSpy);
assert.equal(telegram.sent.length, sentBeforePeer + 4, '放弃后静默（不再刷屏）');
const recovT = new Date(t0 + 45 * 60 * 1000); // 对端恢复：心跳把日志写到「当前（假）时刻」
__fs.utimesSync(join(APP_DIR, 'bot.log'), recovT, recovT);
peerTick(t0 + 45 * 60 * 1000, kickSpy);
assert.equal(kicks.length, 3, '恢复后不拉活');
const staleT2 = new Date(t0 + 26 * 60 * 1000); // 再次停摆（相对假时钟 20 分钟前）
__fs.utimesSync(join(APP_DIR, 'bot.log'), staleT2, staleT2); // 再次停摆 → 重新从第 1 次开始
peerTick(t0 + 46 * 60 * 1000, kickSpy);
assert.equal(kicks.length, 4, '恢复后重新纳入看护（计数清零）');
assert.match(telegram.sent[telegram.sent.length - 1].text, /第 1\\/3 次/, '重新计数');

console2.log('bot.js 侧 11 组断言全过');
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
// 审核卡（#4）需要：REVIEWER_MODE 吃 process.env.BOT_ROLE（测试环境必须没有）；
// telegram 桩记录 sendMessage/editMessageText 调用（卡片文本、私聊目标、按钮数据）。
delete process.env.BOT_ROLE;
const telegram = {
  sent: [],
  async sendMessage(chatId, text, extra = {}) { this.sent.push({ chatId, text, extra }); return { ok: true }; },
  async sendRich(chatId, text, extra = {}) { this.sent.push({ chatId, text, extra }); return { ok: true }; },
  async editMessageText() { return { ok: true }; },
};

process.env.DSH_TASK_TABLE = __path.join(${JSON.stringify(TMP)}, '插件侧任务表.md');
process.env.DSH_PEER_ROOT = __path.join(${JSON.stringify(TMP)}, 'peer-root'); // #11 对端指向测试目录（防读真主 bot）
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

// 4) 审核卡（#4）：待审核行 → 老板私聊卡片恰发一次（带 inline_keyboard 回调数据）；
//    占位重复轮询不重发；换一行再发。发卡不动任务表（本插件只传话）。
const snapBeforeCard = __fs.readFileSync(TASK_TABLE, 'utf8');
__fs.writeFileSync(TASK_TABLE, [
  '# t',
  '> 协作群 chat id: -100777',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 11 | 修轮询僵死 | 002bot | 待审核 | ✅ 验收通过（测试桩） |',
].join('\\n'));
intervalFn();
await new Promise((r) => setTimeout(r, 5)); // 发卡是异步的，让微任务跑完
assert.equal(telegram.sent.length, 1, '待审核行应发一张卡');
assert.equal(telegram.sent[0].chatId, 7, '卡片发老板私聊（owner）');
assert.match(telegram.sent[0].text, /#11/);
assert.match(telegram.sent[0].text, /修轮询僵死/);
const buttons = telegram.sent[0].extra?.reply_markup?.inline_keyboard?.[0] ?? [];
assert.deepEqual(buttons.map((b) => b.callback_data), ['review:approve:11', 'review:reject:11'], '按钮回调数据形状');
intervalFn();
await new Promise((r) => setTimeout(r, 5));
assert.equal(telegram.sent.length, 1, '同一行不重发卡');
const tableAfterCard = __fs.readFileSync(TASK_TABLE, 'utf8');
__fs.writeFileSync(TASK_TABLE, tableAfterCard.replace('修轮询僵死', '审核弹窗'));
intervalFn();
await new Promise((r) => setTimeout(r, 5));
assert.equal(telegram.sent.length, 1, '同一行改任务文本也不重发（按 #N 去重）');
assert.equal(__fs.readFileSync(TASK_TABLE, 'utf8'), tableAfterCard.replace('修轮询僵死', '审核弹窗'), '发卡不改任务表状态');
// 5) 互为看门狗（#11）：插件版查主 bot——独立 peer-root（防与 bTest 的对端路径碰撞）
const peerRoot5 = __path.join(${JSON.stringify(TMP)}, 'peer-root');
__fs.mkdirSync(peerRoot5, { recursive: true });
__fs.writeFileSync(join(peerRoot5, '.bot.pid'), String(process.pid));
__fs.writeFileSync(join(peerRoot5, 'bot.log'), '[hb] 心跳正常（主 bot 测试桩）\\n');
const kicks5 = [];
const kickSpy5 = () => { kicks5.push(1); };
const sentBeforePeer5 = telegram.sent.length;
peerTick(Date.now(), kickSpy5);
assert.equal(kicks5.length, 0, '主 bot 健康不许拉活');
assert.equal(telegram.sent.length, sentBeforePeer5, '主 bot 健康不许公告');
const stale5 = new Date(Date.now() - 20 * 60 * 1000);
__fs.utimesSync(join(peerRoot5, 'bot.log'), stale5, stale5);
peerTick(Date.now(), kickSpy5);
assert.equal(kicks5.length, 1, '主 bot 假活必须拉活');
assert.match(telegram.sent[telegram.sent.length - 1].text, /主 bot 判假活/, '公告要有谁+判定');
assert.match(telegram.sent[telegram.sent.length - 1].text, /第 1\\/3 次/, '公告要标第几次拉活');
peerTick(Date.now() + 11 * 60 * 1000, kickSpy5);
assert.equal(kicks5.length, 2, '冷却过后第二次拉活');
peerTick(Date.now() + 22 * 60 * 1000, kickSpy5);
peerTick(Date.now() + 33 * 60 * 1000, kickSpy5);
assert.equal(kicks5.length, 3, '连续 3 次后停止');
assert.match(telegram.sent[telegram.sent.length - 1].text, /停止自动重试/, '升级公告');
peerTick(Date.now() + 44 * 60 * 1000, kickSpy5);
assert.equal(kicks5.length, 3, '放弃后静默');
console2.log('index.js 侧 5 组断言全过');
`;

const script = `${pathImport}${fsStub}\nconst __run = async () => {\n{\n${bTest}\n}\n{\n${iTest}\n}\n};\nawait __run();\n`;
const testFile = `${TMP}/run.mjs`;
writeFileSync(testFile, script);
await import(testFile);
console.log('ALL PASS');

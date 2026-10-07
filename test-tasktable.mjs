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
// 审核卡回调（#15）：连同真实的 authorize / handleCallbackQuery 一起抽出来直驱
const aStart = idx.indexOf('function authorize(userId)');
const aEnd = idx.indexOf('  // ---', aStart);
assert.ok(aStart > 0 && aEnd > aStart, 'authorize 切片失败');
const aChunk = idx.slice(aStart, aEnd).split('\n').map((l) => l.replace(/^  /, '')).join('\n');
const cbStart = idx.indexOf('async function handleCallbackQuery(query)');
const cbEnd = idx.lastIndexOf('/**', idx.indexOf('* 斜杠命令', cbStart));
assert.ok(cbStart > 0 && cbEnd > cbStart, 'handleCallbackQuery 切片失败');
const cbChunk = idx.slice(cbStart, cbEnd).split('\n').map((l) => l.replace(/^  /, '')).join('\n');

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
// 拉活全程打桩（默认 defaultWorkerKick 会真 spawn launchctl —— 测试环境绝不真拉）
const kicks9 = [];
const kickSpy9 = () => { kicks9.push(1); };
// 9a 健康小工必须不报（防误报锁死）：pid=本测试进程（kill -0 必活）+ 日志新鲜（=心跳刚写过）
for (const name of WORKER_NAMES) {
  __fs.writeFileSync(join(APP_DIR, \`.bot.pid-\${name}\`), String(process.pid));
  __fs.writeFileSync(join(APP_DIR, \`bot-\${name}.log\`), '[hb] 心跳正常（测试桩）\\n');
}
const sentBefore = telegram.sent.length;
herdTick(Date.now(), kickSpy9);
assert.equal(telegram.sent.length, sentBefore, '四个小工全健康 → 不许公告');
assert.equal(kicks9.length, 0, '四个小工全健康 → 不许拉活');

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
herdTick(Date.now(), kickSpy9);
assert.equal(telegram.sent.length, sentBefore + 1, '日志停摆必须公告');
assert.equal(kicks9.length, 1, '假活第一次必须触发拉活');
assert.match(telegram.sent[telegram.sent.length - 1].text, /kickstart 拉活（第 1\\/3 次）/, '公告要标第几次拉活');
assert.match(telegram.sent[telegram.sent.length - 1].text, /001bot 判假活/, '判据里要有谁+判定');
assert.match(telegram.sent[telegram.sent.length - 1].text, /20 分钟/, '判据里要有多久没动');
assert.match(telegram.sent[telegram.sent.length - 1].text, /#20/, '公告里要提改派哪行');
assert.match(__fs.readFileSync(TASK_TABLE_PATH, 'utf8'), /\\| 20 \\| 假活名下的活 \\| 001bot \\| 待领取 \\|/, '进行中的行翻「待领取」');
assert.match(__fs.readFileSync(TASK_TABLE_PATH, 'utf8'), /看门狗改派/, '结论列注明改派原因');
herdTick(Date.now(), kickSpy9);
assert.equal(telegram.sent.length, sentBefore + 1, '同一小工连续判死不重复公告（边沿触发）');
assert.equal(kicks9.length, 1, '冷却期内不重复拉活');

// 9c pid 真死必报：pidfile 写一个已退出的 pid
const cp = await import('node:child_process');
const deadPid = cp.spawnSync('true').pid;
__fs.writeFileSync(join(APP_DIR, '.bot.pid-003bot'), String(deadPid));
herdTick(Date.now(), kickSpy9);
assert.equal(telegram.sent.length, sentBefore + 2, 'pid 死必须公告');
assert.equal(kicks9.length, 2, '判死同样要拉活');
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
herdTick(t0, kickSpy9); // 快照首见：不公告
assert.equal(telegram.sent.length, sentBefore + 2, '首见只记快照');
// 拨钟 31 分钟：存活判据用同一个钟 → 日志 mtime 必须一起摸到新时刻（=心跳照写，
// 这正是健康小工的形状），否则看门狗会先把全组判假活（测试时间旅行要自洽）
const tA = new Date(t0 + 31 * 60 * 1000);
for (const name of WORKER_NAMES) __fs.utimesSync(join(APP_DIR, \`bot-\${name}.log\`), tA, tA);
herdTick(t0 + 31 * 60 * 1000, kickSpy9); // 31 分钟后同状态 → 停
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
herdTick(t1, kickSpy9);
const t2 = new Date(t1 + 31 * 60 * 1000);
for (const name of WORKER_NAMES) __fs.utimesSync(join(APP_DIR, \`bot-\${name}.log\`), t2, t2);
herdTick(t1 + 31 * 60 * 1000, kickSpy9);
assert.equal(telegram.sent.length, sentBefore + 4, '待领取卡住要公告');
assert.match(telegram.sent[telegram.sent.length - 1].text, /#23（003bot）卡住/, '公告点名');
assert.match(__fs.readFileSync(TASK_TABLE_PATH, 'utf8'), /\\| 23 \\| 没人领的活 \\| 003bot \\| 待领取 \\|/, '待领取保持原状态');

// 9f-9i 拉活状态机（2026-10-07 老板补令：判死/假活直接拉活+防风暴）——004bot 独立跑全套
const kicks9f = [];
const kickSpy9f = (name) => { kicks9f.push(name); };
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 24 | 假活小工名下的活 | 004bot | 进行中 | — |',
].join('\\n'));
const sentBefore9f = telegram.sent.length;
// 场景隔离：003bot 从 9c 的死 pid 复活（否则它的拉活状态机会横跨到本组继续计数）；
// 拨假钟时把健康小工日志摸到假现在（同 9d 的「时间旅行要自洽」），只有 004bot 保持停摆
__fs.writeFileSync(join(APP_DIR, '.bot.pid-003bot'), String(process.pid));
const herdTick9 = (t) => {
  const d = new Date(t);
  for (const n of WORKER_NAMES) if (n !== '004bot') __fs.utimesSync(join(APP_DIR, \`bot-\${n}.log\`), d, d);
  herdTick(t, kickSpy9f);
};
const t9 = Date.now();
const stale9 = new Date(t9 - 20 * 60 * 1000);
__fs.utimesSync(join(APP_DIR, 'bot-004bot.log'), stale9, stale9);
// 9f 首判：公告 + 第 1 次拉活 + 改派，三者并行
herdTick9(t9);
assert.equal(kicks9f.length, 1, '假活小工第一次必须触发拉活');
assert.equal(kicks9f[0], '004bot', '拉的是判死那个小工');
assert.match(telegram.sent[telegram.sent.length - 1].text, /004bot 判假活/, '公告要有谁+判定');
assert.match(telegram.sent[telegram.sent.length - 1].text, /kickstart 拉活（第 1\\/3 次）/, '公告要标第几次拉活');
assert.match(telegram.sent[telegram.sent.length - 1].text, /#24/, '拉活同时改派名下活');
assert.match(__fs.readFileSync(TASK_TABLE_PATH, 'utf8'), /\\| 24 \\| 假活小工名下的活 \\| 004bot \\| 待领取 \\|/, '改派与拉活并行');
// 9g 冷却期：10 分钟内不重复拉同一个小工
herdTick9(t9 + 5 * 60 * 1000);
assert.equal(kicks9f.length, 1, '冷却期内第二次必须不拉');
assert.equal(telegram.sent.length, sentBefore9f + 1, '冷却期内不刷屏');
// 9h 冷却过后逐次拉；连拉 3 次不活 → 第 4 次判定升级给老板并停手
herdTick9(t9 + 11 * 60 * 1000);
assert.equal(kicks9f.length, 2, '冷却过后第二次拉活');
herdTick9(t9 + 22 * 60 * 1000);
assert.equal(kicks9f.length, 3, '第三次拉活');
herdTick9(t9 + 33 * 60 * 1000);
assert.equal(kicks9f.length, 3, '连续 3 次后不再拉');
assert.match(telegram.sent[telegram.sent.length - 1].text, /停止自动重试/, '升级公告找老板');
herdTick9(t9 + 44 * 60 * 1000);
assert.equal(telegram.sent.length, sentBefore9f + 4, '放弃后静默（首判+2 次续拉+升级共 4 条）');
// 9i 恢复清零：日志摸新 → 不拉活；再次停摆 → 重新从第 1 次开始
const tRec = t9 + 45 * 60 * 1000;
__fs.utimesSync(join(APP_DIR, 'bot-004bot.log'), new Date(tRec), new Date(tRec));
herdTick9(tRec);
assert.equal(kicks9f.length, 3, '恢复后不拉活');
const stale9b = new Date(t9 + 46 * 60 * 1000 - 20 * 60 * 1000);
__fs.utimesSync(join(APP_DIR, 'bot-004bot.log'), stale9b, stale9b);
herdTick9(t9 + 46 * 60 * 1000);
assert.equal(kicks9f.length, 4, '恢复后重新纳入看护（计数清零）');
assert.match(telegram.sent[telegram.sent.length - 1].text, /kickstart 拉活（第 1\\/3 次）/, '重新计数');

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

// （#11 互为看门狗测试组已随功能整体删除，2026-10-07 老板令。）
console2.log('bot.js 侧 10 组断言全过');
`;

// ---------- index.js 侧测试 ----------
const iTest = `
// ---- src/index.js 侧：领活 watcher ----
const state = { stopped: false, ownerUserId: 7, claimed: false };
let enqueued = [];
const enqueue = (key, task) => { enqueued.push({ key, task }); };
let prompted = [];
const promptFromHub = async (msg) => { prompted.push(msg); return { ok: true }; };
const log = () => {};
const error = (...a) => console2.error(...a);
let intervalFn = null;
const setInterval = (fn) => { intervalFn = fn; return 8; };
// 审核卡（#15）需要：REVIEWER_MODE 吃 process.env.BOT_ROLE（测试环境必须没有）；
// telegram 桩记录 sendMessage/editMessageText/answerCallbackQuery 调用
// （卡片文本、群目标、按钮数据、卡片 edit、按钮应答）。
delete process.env.BOT_ROLE;
const telegram = {
  sent: [],
  edits: [],
  answers: 0,
  async sendMessage(chatId, text, extra = {}) { this.sent.push({ chatId, text, extra }); return { ok: true }; },
  async sendRich(chatId, text, extra = {}) { this.sent.push({ chatId, text, extra }); return { ok: true }; },
  async editMessageText(chatId, messageId, text) { this.edits.push({ chatId, messageId, text }); return { ok: true }; },
  async answerCallbackQuery() { this.answers += 1; return { ok: true }; },
};
// 真实 authorize 切片消费 config.telegramAllowedUsers：白名单 = [老板 7, 第二名 8]。
// 8 过 authorize 是真实生产场景（多白名单人）——非老板点击零动作只能靠身份门挡住，
// 测试判据才成立（打桩若把 authorize 写成全员拒绝，身份门被删测试照样绿=假测试）。
const config = { telegramAllowedUsers: [7, 8] };
// handleCallbackQuery 里 approvalBridge?.… 需要标识符存在（本测试不触发审批桥）。
const approvalBridge = null;

process.env.DSH_TASK_TABLE = __path.join(${JSON.stringify(TMP)}, '插件侧任务表.md');
const TASK_TABLE = process.env.DSH_TASK_TABLE;

${iChunk}
${aChunk}
${cbChunk}

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

// 4) 审核卡（#15）：待审核行 → 协作群卡片恰发一次（群 id=表头优先；带 inline_keyboard 回调数据）；
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
assert.equal(telegram.sent[0].chatId, '-100777', '卡片发协作群（表头群 id 优先，不发私聊）');
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

// 4b) 表头无群 id → 兜底协作群 -5334440553（#15：不再兜底老板私聊）
__fs.writeFileSync(TASK_TABLE, [
  '# t',
  '> 协作群 chat id:（占位）',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 12 | 表头占位时的活 | 003bot | 待审核 | ✅ 验收通过（测试桩） |',
].join('\\n'));
intervalFn();
await new Promise((r) => setTimeout(r, 5));
assert.equal(telegram.sent.length, 2, '新行再发一张卡');
assert.equal(telegram.sent[1].chatId, '-5334440553', '无表头群 id → 兜底 -5334440553（不发私聊）');

// 5) 审核卡回调（#15）：真实 authorize + 真实 handleCallbackQuery 直驱。
const press = (fromId, data, messageId = 55) =>
  handleCallbackQuery({ id: 'q', from: { id: fromId }, data, message: { chat: { id: -100777 }, message_id: messageId } });
// 5a) 老板点 ✅ → 群发「通过 #11」（一字不改）+ 卡片 edit（卡片在群里，edit 也落群里）
__fs.writeFileSync(TASK_TABLE, [
  '# t',
  '> 协作群 chat id: -100777',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 11 | 修轮询僵死 | 002bot | 待审核 | ✅ 验收通过（测试桩） |',
].join('\\n'));
const sentBeforeBossApprove = telegram.sent.length;
await press(7, 'review:approve:11');
assert.equal(telegram.answers, 1, '老板点击要应答按钮');
assert.equal(telegram.sent.length, sentBeforeBossApprove + 1, '✅ 应群发一条');
assert.equal(telegram.sent[telegram.sent.length - 1].chatId, '-100777', '「通过 #N」发协作群');
assert.equal(telegram.sent[telegram.sent.length - 1].text, '通过 #11', '「通过 #N」格式一字不改（主 bot 监听依赖）');
assert.equal(telegram.edits.length, 1, '卡片要 edit 防重按');
assert.equal(telegram.edits[0].chatId, -100777, '卡片在协作群，edit 也落协作群');
// 5b) 老板点 ❌ → 只 edit 卡片提示群里发「打回 #N：原因」；⛔ 不代发任何群文本（原因必须老板原话）
const sentBeforeBossReject = telegram.sent.length;
await press(7, 'review:reject:11', 56);
assert.equal(telegram.answers, 2);
assert.equal(telegram.sent.length, sentBeforeBossReject, '❌ 不得代发「打回 #N：…」进群（原因必须是老板原话）');
assert.equal(telegram.edits.length, 2, '❌ 要 edit 卡片追问');
assert.match(telegram.edits[1].text, /打回 #11：原因/, '卡片提示里给出固定格式');
// 5c) 非老板（白名单第二名 8）点击 → 零动作（authorize 放行他，零动作只能靠身份门）
const sentBeforeStranger = telegram.sent.length;
const editsBeforeStranger = telegram.edits.length;
await press(8, 'review:approve:11');
await press(8, 'review:reject:11');
assert.equal(telegram.sent.length, sentBeforeStranger, '非老板点击零群发');
assert.equal(telegram.edits.length, editsBeforeStranger, '非老板点击零 edit');
assert.equal(telegram.answers, 2, '非老板点击连按钮应答都不发（零动作）');
assert.equal(state.ownerUserId, 7, '非老板点击不得抢认领/改锚点');
// 5d) 未认领实例（ownerUserId=null）+ 群里陌生人按旧卡 → 零动作且不得被认领成主人
state.ownerUserId = null;
await press(99, 'review:approve:11');
assert.equal(state.ownerUserId, null, 'authorize 的认领分支不得被群里点击触发');
assert.equal(telegram.sent.length, sentBeforeStranger, '未认领时点击零群发');
assert.equal(telegram.edits.length, editsBeforeStranger, '未认领时点击零 edit');
state.ownerUserId = 7;

// （#11 互为看门狗测试组已随功能整体删除，2026-10-07 老板令。）
console2.log('index.js 侧 5 组断言全过');
`;

const script = `${pathImport}${fsStub}\nconst __run = async () => {\n{\n${bTest}\n}\n{\n${iTest}\n}\n};\nawait __run();\n`;
const testFile = `${TMP}/run.mjs`;
writeFileSync(testFile, script);
await import(testFile);
console.log('ALL PASS');

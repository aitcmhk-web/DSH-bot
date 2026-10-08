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
const dirname = (...a) => __path.dirname(...a); // #38：#32/#34 半成品 herd 段（apply 顶层）用裸名 dirname，harness 先例照 join 供给
// #38：herd/triggers 是 ./herd.js、./triggers.js 的 export —— run.mjs 单文件拼接没有模块可 import，
// 照 fsStub 先例给 no-op stub 让 iChunk 拼装面可跑。本测不测看门狗/触发器行为（归 #32/#33 判据）。
const HERD_GROUP_FALLBACK = '-5334440553';
const createHerdWatchdog = () => ({ start() {} });
const createTaskTriggers = () => ({ start() {} });
const assert = (await import('node:assert')).strict;
const console2 = console;
`;
const pathImport = `import { join as __join, dirname as __dirname } from 'node:path';\nconst __path = { join: __join, dirname: __dirname };\n`;

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

// 11) 审核按钮接力（#25）：待审核行结论列出现插件写的「✅ 老板已通过（审核按钮 …）」→
//     置「发布中」占位防重 + 触发发版回合。TG 平台不投递 bot 间发言（官方 Bots FAQ），
//     插件群发的「通过 #N」主 bot 天生收不到 —— 接力只能走两边都在 5 秒轮询的任务表。
watchTaskTable(); // 第 10 组把 intervalFn 换成了 worker tick，这里换回主 bot tick
// 11a 命中并触发（worker 名下）
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 40 | 按钮通过的活 | 002bot | 待审核 | ✅ 验收通过（测试桩）；✅ 老板已通过（审核按钮 10-07 17:33，message_id=777） |',
].join('\\n'));
const submittedBefore11 = submitted.length;
intervalFn();
assert.equal(submitted.length, submittedBefore11 + 1, '通过标记必须触发发版回合（主 bot 侧接收证据）');
assert.match(submitted[submitted.length - 1].blocks[0].text, /#40/, '发版回合要带行号');
assert.match(submitted[submitted.length - 1].blocks[0].text, /发版/, '回合必须是发版指令');
assert.match(readTaskTable(), /\\| 40 \\| 按钮通过的活 \\| 002bot \\| 发布中 \\|/, '触发前先置「发布中」占位防重');
intervalFn();
assert.equal(submitted.length, submittedBefore11 + 1, '占位后不得重复触发');
// 11b 插件版名下的待审核行也要能接力（#21 形状 —— 占位与触发都不许被 worker 门挡住）
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 41 | 插件版名下的活 | 插件版 | 待审核 | ✅ 老板已通过（审核按钮 10-07 18:00，message_id=778） |',
].join('\\n'));
intervalFn();
assert.equal(submitted.length, submittedBefore11 + 2, '插件版名下的通过标记也要触发');
assert.match(readTaskTable(), /\\| 41 \\| 插件版名下的活 \\| 插件版 \\| 发布中 \\|/, '非 worker 名下也要能占位');
// 11c 无标记的待审核行 → 不触发（老板还没点按钮，等审核就是等审核，状态一个字不许动）
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 42 | 还在等审核的活 | 003bot | 待审核 | ✅ 验收通过（测试桩） |',
].join('\\n'));
intervalFn();
assert.equal(submitted.length, submittedBefore11 + 2, '无标记不许触发');
assert.match(readTaskTable(), /\\| 42 \\| 还在等审核的活 \\| 003bot \\| 待审核 \\|/, '没触发不许动状态');

// 12)（#41）例行进度汇报·worker 侧（2026-10-08 老板令）：master 侧插件（src/progress-report.js，
//     挂 herd 心跳）每 5 分钟在「进行中」行结论列落请求标记 ⏰ 汇报请求(MM-DD HH:MM)；
//     本侧领活轮询捡标记 → submitTurn 固定提示词进协作群（领活同款通路）；忙（在途回合
//     未清）→ 只刷新标记不投递（防堆叠）；领活占位剥陈旧标记；无标记/非进行中行零动作。
const chatMailboxes = new Map(); // bot.js 模块级（切片外），测试桩同形状
watchWorkerTasks(); // 换 worker tick（第 10/11 组已把 intervalFn 换回主 bot tick）
const stampAgo12 = (min) => {
  const d = new Date(Date.now() - min * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};
// 12a 空闲 + 本实例「进行中」行带标记 → 投递固定提示词 + 剥标记
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 50 | 汇报的活 | 002bot | 进行中 | 前情；⏰ 汇报请求(' + stampAgo12(6) + ') |',
].join('\\n'));
const submittedBefore12 = submitted.length;
intervalFn();
assert.equal(submitted.length, submittedBefore12 + 1, '空闲应投递例行进度汇报');
assert.equal(submitted[submitted.length - 1].chatId, -100888, '投递进协作群（表头群 id，回答即汇报）');
assert.match(submitted[submitted.length - 1].blocks[0].text, /例行进度汇报：①本单进展到哪一步 ②下一步干什么 ③需要解决的问题（无也要报无）/, '固定提示词一字不改');
assert.match(submitted[submitted.length - 1].blocks[0].text, /<例行汇报（系统触发，无需回复此段）>/, '系统触发头尾（领活同款形状）');
assert.doesNotMatch(readTaskTable(), /⏰ 汇报请求/, '投递前剥标记（master 下拍重落，不堆积）');
assert.match(readTaskTable(), /前情/, '前情结论保留');
// 12b 忙（在途回合未清）+ 标记旧（6 分钟 > 4 分钟门槛）→ 只刷新标记不投递（防堆叠）
chatMailboxes.set(-100888, { running: true, pending: [] });
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 50 | 汇报的活 | 002bot | 进行中 | 前情；⏰ 汇报请求(' + stampAgo12(6) + ') |',
].join('\\n'));
const oldStamp12 = readTaskTable().match(/⏰ 汇报请求\\((\\d{2}-\\d{2} \\d{2}:\\d{2})\\)/)[1];
intervalFn();
assert.equal(submitted.length, submittedBefore12 + 1, '忙时不许投递（followup 排队语义下再排只会堆积）');
const tableAfter12b = readTaskTable();
assert.doesNotMatch(tableAfter12b, new RegExp(oldStamp12), '旧时间戳要被刷掉（=活着证明，master 判龄依据）');
assert.match(tableAfter12b, /⏰ 汇报请求\\(\\d{2}-\\d{2} \\d{2}:\\d{2}\\)/, '标记还在（master 侧按新鲜在途跳过，不升级）');
assert.match(tableAfter12b, /前情/, '前情保留');
// 12b2 忙 + 标记新鲜（< 4 分钟门槛）→ 零写表零投递（防 5 秒轮询刷屏写表）
__fs.writeFileSync(TASK_TABLE_PATH, tableAfter12b);
const snap12b2 = readTaskTable();
intervalFn();
assert.equal(submitted.length, submittedBefore12 + 1, '标记新鲜+忙 → 零投递');
assert.equal(readTaskTable(), snap12b2, '标记新鲜+忙 → 零写表');
chatMailboxes.delete(-100888);
// 12c 反向：无标记的进行中行 / 已发布行 → 零投递零写表
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 51 | 无标记的活 | 002bot | 进行中 | — |',
  '| 52 | 已发布的活 | 002bot | 已发布 | ✅ 老板已通过 |',
].join('\\n'));
const snap12c = readTaskTable();
intervalFn();
assert.equal(submitted.length, submittedBefore12 + 1, '无标记/已发布 → 零投递');
assert.equal(readTaskTable(), snap12c, '无标记/已发布 → 零写表（master 没落请求就没汇报）');
// 12d 领活占位剥陈旧标记：待领取行结论带旧标记 → 领活时剥掉（新单从干净汇报账起步，
//     防上单遗留的旧标记被 master 按龄误判「2 周期未报」直接升级）
__fs.writeFileSync(TASK_TABLE_PATH, [
  '# t',
  '> 协作群 chat id: -100888',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 53 | 新领的活 | 002bot | 待领取 | 旧账；⏰ 汇报请求(10-08 20:00) |',
].join('\\n'));
intervalFn();
assert.equal(submitted.length, submittedBefore12 + 2, '待领取照常领（#6 行为不回退）');
assert.match(submitted[submitted.length - 1].blocks[0].text, /领到 #53/, '领的是 53 单');
assert.match(readTaskTable(), /\\| 53 \\| 新领的活 \\| 002bot \\| 进行中 \\| 旧账 \\|/, '占位后陈旧标记剥净');
assert.doesNotMatch(readTaskTable(), /⏰ 汇报请求/, '表上不再有旧标记');
watchTaskTable(); // 换回主 bot tick（同第 10 组后规矩）

console2.log('bot.js 侧 12 组断言全过');
`;

// ---------- index.js 侧测试 ----------
const iTest = `
// ---- src/index.js 侧：领活 watcher ----
const state = { stopped: false, ownerUserId: 7, claimed: false };
let enqueued = [];
const enqueue = (key, task) => { enqueued.push({ key, task }); };
let prompted = [];
const promptFromHub = async (msg) => { prompted.push(msg); return { ok: true }; };
// #25：log/error 记账 —— 群发的 message_id 证据、失败显式报错都要能在桩里断言
const logCalls = [];
const errorCalls = [];
const log = (...a) => { logCalls.push(a.map(String).join(' ')); };
const error = (...a) => { errorCalls.push(a.map(String).join(' ')); };
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
  lastMsgId: 0,
  async sendMessage(chatId, text, extra = {}) {
    // #25 用例钩子：failNextSend=下一次真 throw；noMsgIdOnce=下一次返回不带 message_id（第 16 条假成功）
    if (this.failNextSend) { this.failNextSend = false; throw new Error('测试桩：发送失败'); }
    this.sent.push({ chatId, text, extra });
    if (this.noMsgIdOnce) { this.noMsgIdOnce = false; return { ok: true }; }
    // #38：桩必须按【宿主真实形状】打——宿主 telegram.sendMessage 返回已解包的消息对象
    // （顶层就有 message_id，bot.js:643-644 直接 sent.message_id 消费可证）。
    // 旧桩按裸 Bot API 打 {result:{message_id}} = 打桩比真实现更宽容的测试=没测（第 22 条），
    // 旧代码 result 取法被它喂成假绿。⛔ 桩形状不许再迁就实现。
    this.lastMsgId = 900 + this.sent.length;
    return { ok: true, message_id: this.lastMsgId };
  },
  async sendRich(chatId, text, extra = {}) { this.sent.push({ chatId, text, extra }); return { ok: true }; },
  async editMessageText(chatId, messageId, text) { this.edits.push({ chatId, messageId, text }); return { ok: true }; },
  async answerCallbackQuery() { this.answers += 1; return { ok: true }; },
};
// #20 用例要驱动「5 分钟超时」：遮蔽 setTimeout/clearTimeout（真实 5 分钟定时器会把
// 测试挂住 5 分钟）；超时回调用 rejectTimers 手动拨。测试自己的等待一律走 sleep。
const __realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((r) => __realSetTimeout(r, ms));
const rejectTimers = [];
const setTimeout = (fn, ms) => { rejectTimers.push({ fn, ms }); return rejectTimers.length; };
const clearTimeout = () => {};
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
await sleep(5); // 发卡是异步的，让微任务跑完
assert.equal(telegram.sent.length, 1, '待审核行应发一张卡');
assert.equal(telegram.sent[0].chatId, '-100777', '卡片发协作群（表头群 id 优先，不发私聊）');
assert.match(telegram.sent[0].text, /#11/);
assert.match(telegram.sent[0].text, /修轮询僵死/);
const buttons = telegram.sent[0].extra?.reply_markup?.inline_keyboard?.[0] ?? [];
assert.deepEqual(buttons.map((b) => b.callback_data), ['review:approve:11', 'review:reject:11'], '按钮回调数据形状');
intervalFn();
await sleep(5);
assert.equal(telegram.sent.length, 1, '同一行不重发卡');
const tableAfterCard = __fs.readFileSync(TASK_TABLE, 'utf8');
__fs.writeFileSync(TASK_TABLE, tableAfterCard.replace('修轮询僵死', '审核弹窗'));
intervalFn();
await sleep(5);
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
await sleep(5);
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
// 5b) 老板点 ❌ → edit 卡片追问 +（#20）另发一条 ForceReply 原因条；⛔ 不代发「打回 #N：…」
//     正文（原因必须是老板原话，插件只转成固定格式）
const sentBeforeBossReject = telegram.sent.length;
await press(7, 'review:reject:11', 56);
assert.equal(telegram.answers, 2);
assert.equal(telegram.sent.length, sentBeforeBossReject + 1, '❌ 后只另发一条原因条');
assert.doesNotMatch(telegram.sent[telegram.sent.length - 1].text, /^打回 #11：/, '⛔ 不得代发「打回 #N：…」正文（原因必须是老板原话）');
assert.equal(telegram.sent[telegram.sent.length - 1].extra?.reply_markup?.force_reply?.force_reply, true, '另发那条必须带 ForceReply 键盘（tap 引用直输）');
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

// 5e)（#20）老板回复原因条 → 拼成「打回 #N：原因」群发，格式一字不改；消费后重复回复不重发
const sentBefore5e = telegram.sent.length;
await press(7, 'review:reject:11', 56);
assert.equal(telegram.sent.length, sentBefore5e + 1, '❌ 后应另发原因条');
const promptMsgId5e = telegram.lastMsgId;
const ok5e = await handleRejectReasonReply({ chat: { id: -100777 }, from: { id: 7 }, text: '测试打回原因甲', reply_to_message: { message_id: promptMsgId5e } });
assert.equal(ok5e, true, '老板回复原因条应被消费');
assert.equal(telegram.sent[telegram.sent.length - 1].chatId, '-100777', '代发进协作群');
assert.equal(telegram.sent[telegram.sent.length - 1].text, '打回 #11：测试打回原因甲', '群发文本全等（格式一字不改，主 bot 闭环依赖）');
const sentAfter5e = telegram.sent.length;
const ok5e2 = await handleRejectReasonReply({ chat: { id: -100777 }, from: { id: 7 }, text: '再发一次', reply_to_message: { message_id: promptMsgId5e } });
assert.equal(ok5e2, false, '已消费的原因条不再触发');
assert.equal(telegram.sent.length, sentAfter5e, '重复回复零群发（防重复打回）');

// 5f)（#20）不 reply → 5 分钟超时：原因条 edit 成兜底文案（维持群里手打老路），不群发；迟到回复不触发
await press(7, 'review:reject:11', 56);
const promptMsgId5f = telegram.lastMsgId;
const timer5f = rejectTimers[rejectTimers.length - 1];
assert.equal(timer5f.ms, 5 * 60 * 1000, '超时必须是 5 分钟');
const sentBefore5f = telegram.sent.length;
await timer5f.fn();
await sleep(5);
assert.equal(telegram.sent.length, sentBefore5f, '超时不群发（兜底=群里手打，插件不代发）');
assert.match(telegram.edits[telegram.edits.length - 1].text, /打回 #11：原因/, '超时兜底文案给出固定格式');
assert.match(telegram.edits[telegram.edits.length - 1].text, /请直接在群里发/, '超时兜底文案指向群里手打');
const ok5f = await handleRejectReasonReply({ chat: { id: -100777 }, from: { id: 7 }, text: '迟到的原因', reply_to_message: { message_id: promptMsgId5f } });
assert.equal(ok5f, false, '超时后的迟到回复不再触发');
const sentAfter5f = telegram.sent.length;
await timer5f.fn(); // 幂等：已过期的回调再拨一次必须空转
assert.equal(telegram.sent.length, sentAfter5f, '超时回调幂等（不群发）');

// 5g)（#20 反向）非老板回复原因条 → 零动作；老板随后回复仍恰好生效一次
await press(7, 'review:reject:11', 56);
const promptMsgId5g = telegram.lastMsgId;
const sentBefore5g = telegram.sent.length;
const editsBefore5g = telegram.edits.length;
const ok5g = await handleRejectReasonReply({ chat: { id: -100777 }, from: { id: 8 }, text: '我替老板打回', reply_to_message: { message_id: promptMsgId5g } });
assert.equal(ok5g, false, '非老板回复不消费');
assert.equal(telegram.sent.length, sentBefore5g, '非老板回复零群发');
assert.equal(telegram.edits.length, editsBefore5g, '非老板回复零 edit');
const ok5g2 = await handleRejectReasonReply({ chat: { id: -100777 }, from: { id: 7 }, text: '老板的原因乙', reply_to_message: { message_id: promptMsgId5g } });
assert.equal(ok5g2, true, '非老板回复不得挤掉条目，老板回复仍生效');
assert.equal(telegram.sent[telegram.sent.length - 1].text, '打回 #11：老板的原因乙', '只有老板的回复会代发');
// 5g-2) 未认领实例（ownerUserId=null）→ 任何人回复都零动作
await press(7, 'review:reject:11', 56);
const promptMsgId5g2 = telegram.lastMsgId;
state.ownerUserId = null;
const sentBefore5g2 = telegram.sent.length;
const ok5g3 = await handleRejectReasonReply({ chat: { id: -100777 }, from: { id: 7 }, text: '未认领时的回复', reply_to_message: { message_id: promptMsgId5g2 } });
assert.equal(ok5g3, false, '未认领实例不代发');
assert.equal(telegram.sent.length, sentBefore5g2, '未认领实例零群发');
state.ownerUserId = 7;

// 5h)（#20）/cancel 取消沿用：零群发、条目标记已取消、取消后回复不再触发
await press(7, 'review:reject:11', 56);
const promptMsgId5h = telegram.lastMsgId;
const sentBefore5h = telegram.sent.length;
const ok5h = await handleRejectReasonReply({ chat: { id: -100777 }, from: { id: 7 }, text: '/cancel', reply_to_message: { message_id: promptMsgId5h } });
assert.equal(telegram.sent.length, sentBefore5h, '/cancel 零群发');
assert.match(telegram.edits[telegram.edits.length - 1].text, /已取消/, '原因条标记已取消');
const ok5h2 = await handleRejectReasonReply({ chat: { id: -100777 }, from: { id: 7 }, text: '取消后还回复', reply_to_message: { message_id: promptMsgId5h } });
assert.equal(ok5h, false, '/cancel 走取消分支不当原因');
assert.equal(ok5h2, false, '取消后的回复不再触发');
assert.equal(telegram.sent.length, sentBefore5h, '取消路径全程零群发');

// 5i)（#20 静态接线锁）钩子必须接在 handleTelegramMessage 群模式过滤**之前**
//    （群里回复不带 @点名，挂晚了会被静默丢 —— 这条锁防「函数写了没接线」）
const __idxSrc = __fs.readFileSync('${BOT}/src/index.js', 'utf8');
const __htStart = __idxSrc.indexOf('async function handleTelegramMessage');
assert.ok(__htStart > 0, 'handleTelegramMessage 应存在');
const __hookAt = __idxSrc.indexOf('await handleRejectReasonReply(message)', __htStart);
const __groupAt = __idxSrc.indexOf('const isGroupChat', __htStart);
assert.ok(__hookAt > 0, '钩子要接在 handleTelegramMessage 里');
assert.ok(__hookAt < __groupAt, '钩子必须在群模式过滤之前');

// （#11 互为看门狗测试组已随功能整体删除，2026-10-07 老板令。）

// 6)（#25）✅ 通过 = 两条腿：① 群发「通过 #N」落 message_id 证据（第 16 条；失败显式报错不静默）；
//    ② 任务表通过标记（主 bot 靠它接力发版 —— TG 平台不投递 bot 间发言，群发那条主 bot 天生收不到）。
// 6a 群发成功：日志落 message_id + 卡片 edit 带回执 + 结论列写入标记（状态仍待审核=插件不越权改状态）
__fs.writeFileSync(TASK_TABLE, [
  '# t',
  '> 协作群 chat id: -100777',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 13 | 按钮通过的活 | 002bot | 待审核 | ✅ 验收通过（测试桩） |',
].join('\\n'));
logCalls.length = 0;
errorCalls.length = 0;
await press(7, 'review:approve:13');
assert.equal(telegram.sent[telegram.sent.length - 1].text, '通过 #13', '「通过 #N」格式一字不改（群发只给人看）');
assert.ok(logCalls.some((l) => /群发「通过 #13」成功（message_id=\\d+）/.test(l)), '群发成功必须落 message_id 证据（第 16 条）');
assert.match(telegram.edits[telegram.edits.length - 1].text, /message_id=/, '卡片回执带 message_id');
assert.match(telegram.edits[telegram.edits.length - 1].text, /已发协作群（message_id=/, '卡片走「已发协作群（message_id=…）」分支（#38 判据②）');
assert.doesNotMatch(telegram.edits[telegram.edits.length - 1].text, /没拿到送达回执/, '正常发送不得再报「没拿到送达回执」（#38 判据②）');
assert.match(telegram.edits[telegram.edits.length - 1].text, /等主 bot 发版/, '卡片告知已写标记接力');
const row13 = __fs.readFileSync(TASK_TABLE, 'utf8').split('\\n').find((l) => /^\\|\\s*13\\s*\\|/.test(l));
assert.ok(row13, '行还在');
assert.match(row13, /✅ 老板已通过（审核按钮/, '结论列必须写入通过标记（主 bot 接力腿）');
assert.match(row13, /message_id=\\d+/, '标记里带 message_id');
assert.match(row13, /\\| 待审核 \\|/, '插件只写事实标记，状态流转归主 bot（不得翻状态）');
// 6b 行不在「待审核」（已发布）→ 不写标记防翻旧账，卡片/日志如实说没写成
__fs.writeFileSync(TASK_TABLE, [
  '# t',
  '> 协作群 chat id: -100777',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 14 | 已经发布的活 | 002bot | 已发布 | 🚀 已发布（测试桩） |',
].join('\\n'));
logCalls.length = 0;
await press(7, 'review:approve:14');
const row14 = __fs.readFileSync(TASK_TABLE, 'utf8').split('\\n').find((l) => /^\\|\\s*14\\s*\\|/.test(l));
assert.doesNotMatch(row14, /老板已通过/, '非待审核行不许写标记（防翻旧账）');
assert.match(row14, /\\| 已发布 \\|/, '状态不许动');
assert.ok(logCalls.some((l) => /任务表标记未写成/.test(l)), '没写成要显式记账');
assert.match(telegram.edits[telegram.edits.length - 1].text, /没写成/, '卡片要如实说标记没写成');
// 6c 发送失败（throw）→ 显式报错不静默 + 卡片如实说没回执 + 标记仍写（通过事实不受群发失败影响）
__fs.writeFileSync(TASK_TABLE, [
  '# t',
  '> 协作群 chat id: -100777',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 15 | 群发会失败的活 | 003bot | 待审核 | ✅ 验收通过（测试桩） |',
].join('\\n'));
logCalls.length = 0;
errorCalls.length = 0;
telegram.failNextSend = true;
await press(7, 'review:approve:15');
assert.ok(errorCalls.some((l) => /群发「通过 #15」失败/.test(l)), '发送失败必须显式报错不静默');
assert.match(telegram.edits[telegram.edits.length - 1].text, /没拿到送达回执/, '卡片如实说没回执，不装成功');
const row15 = __fs.readFileSync(TASK_TABLE, 'utf8').split('\\n').find((l) => /^\\|\\s*15\\s*\\|/.test(l));
assert.match(row15, /✅ 老板已通过（审核按钮/, '通过事实不受群发失败影响，标记照写');
assert.match(row15, /message_id=无回执/, '没回执就明说无回执');
assert.match(row15, /\\| 待审核 \\|/, '状态仍不许动');
// 6d 返回没带 message_id（第 16 条：ret/ok 都不算数）→ 显式报错 + 标记仍写
__fs.writeFileSync(TASK_TABLE, [
  '# t',
  '> 协作群 chat id: -100777',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 16 | 假成功也要留痕的活 | 004bot | 待审核 | ✅ 验收通过（测试桩） |',
].join('\\n'));
logCalls.length = 0;
errorCalls.length = 0;
telegram.noMsgIdOnce = true;
await press(7, 'review:approve:16');
assert.ok(errorCalls.some((l) => /没有 message_id/.test(l)), '假成功必须显式报错（第 16 条）');
assert.ok(logCalls.some((l) => /无送达回执/.test(l)), '汇总日志也要标无回执');
const row16 = __fs.readFileSync(TASK_TABLE, 'utf8').split('\\n').find((l) => /^\\|\\s*16\\s*\\|/.test(l));
assert.match(row16, /message_id=无回执/, '假成功的标记明说无回执');

// 12)（#39）审批桥卡片发协作群（老板 2026-10-08 定「提权申请也放在群里，和审核一样」）。
//     getChatId 源文本从 src/index.js 原样抽出（测的是源码不是复刻，文件头铁律），
//     配真实 approval-bridge.js 模块直驱 approval/request，断言卡片 sendMessage 的 chatId：
//     12a 表头群 id → 协作群；12b 表头无群 id → 回退 ownerUserId 私聊（不失联）。
const __gAt = __idxSrc.indexOf('getChatId:');
const __gEnd = __idxSrc.indexOf('\\n    log,', __gAt);
assert.ok(__gAt > 0 && __gEnd > __gAt, 'getChatId 段应存在于 src/index.js（切片锚点）');
const __gChunk = __idxSrc.slice(__gAt, __gEnd); // 「getChatId: …,」成员原文（含尾逗号）
const __getChatId = new Function(
  'telegram', 'state', 'groupChatIdFromTable',
  'return ({ ' + __gChunk + ' }).getChatId;',
)(telegram, state, groupChatIdFromTable);
const { installApprovalBridge } = await import('${BOT}/src/approval-bridge.js');
const __approvalHandlers = [];
const __bridge = installApprovalBridge({
  ctx: { on(type, fn) { __approvalHandlers.push(fn); return () => {}; } },
  telegram,
  getChatId: __getChatId,
  log,
  error,
});
const __fireApproval = async (reason) => {
  void __approvalHandlers[0]({ reason, toolName: 'bash', signal: null }, () => 'unavailable');
  await sleep(5); // 卡片发送是异步的，让微任务跑完（4 组审核卡同款节奏）
};
// 12a 表头有群 id → 卡片发协作群
__fs.writeFileSync(TASK_TABLE, [
  '# t',
  '> 协作群 chat id: -5334440553',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 39 | 提权卡片进群的活 | 插件版 | 进行中 | — |',
].join('\\n'));
const sentBefore12 = telegram.sent.length;
await __fireApproval('测试提权申请（#39）');
assert.equal(telegram.sent.length, sentBefore12 + 1, '审批请求应发一张卡片');
assert.equal(telegram.sent[telegram.sent.length - 1].chatId, -5334440553, '提权卡片必须发协作群（表头群 id 优先，不发私聊）');
assert.match(telegram.sent[telegram.sent.length - 1].text, /等待审批/, '卡片是等待审批形状');
// 12b 表头无群 id → 回退 ownerUserId 私聊（群 id 缺失不失联）
__fs.writeFileSync(TASK_TABLE, [
  '# t',
  '> 协作群 chat id:（占位）',
  '| # | 任务 | 负责 | 状态 | 验收结论 |',
  '|---|---|---|---|---|',
  '| 39 | 提权卡片进群的活 | 插件版 | 进行中 | — |',
].join('\\n'));
await __fireApproval('测试群 id 缺失回退');
assert.equal(telegram.sent[telegram.sent.length - 1].chatId, 7, '表头无群 id → 回退 owner 私聊 7（不失联）');
__bridge.dispose(); // 清挂起项（超时定时器已被遮蔽，这里连 pending 一起收干净）
console2.log('index.js 侧 6 组断言全过');
`;

const script = `${pathImport}${fsStub}\nconst __run = async () => {\n{\n${bTest}\n}\n{\n${iTest}\n}\n};\nawait __run();\n`;
const testFile = `${TMP}/run.mjs`;
writeFileSync(testFile, script);
await import(testFile);
console.log('ALL PASS');

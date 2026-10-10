// 任务 #49 回归测试（2026-10-09）：报错箱监听的 bot.js 主实例真身接线。
//
// 背景：#46 的接线只在插件 src/index.js 里，主 bot 进程从不挂插件 → 真机零反应
//（15:00 测试行追加成功但 [报错箱] 零行、偏移/锁文件均不存在）。#49 照 #45 同款把
// 接线搬进 bot.js。本测试只测「接线」这一层（机制面 test-mailbox.mjs 20 组已盖）：
//   A. 真机报错箱内容基线实测（任务验证②）：真 报错箱.md 拷进 /tmp —— 首跑基线到 EOF
//      不回放（15:00 测试行不当新报错）、偏移文件落盘；新追加行才注入。
//   B. bot.js 接线静态断言（真实源码文本，非复刻）：import 权威源、master 门+选主、
//      注入腿 submitTurn + {ok:true}（⛔ 不可省，省了 mailboxTick 会判失败死循环重投）、
//      提示词没复制第二份、插件侧接线原样保留、shutdown 收尾、版本号两处同步。
//   C. bot.js 接线块真实切片直驱（master/worker 双角色，/tmp 沙箱）：master 起监听、
//      新行经 submitTurn 注入「📬 报错箱新条目」、空行/#注释/残行不触发不崩；
//      worker 不起监听。
import { readFileSync, writeFileSync, appendFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const BOT = '/Users/tcm/DSH/BOT';

const scratchDirs = [];
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'dsh-mailbox-wiring-'));
  scratchDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

/** 等异步基线（start() 里启动即扫的 void tick()）落定。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, what = '条件') {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${what}`);
    await sleep(20);
  }
}

// ── A 组：真机报错箱内容基线实测（验证②）──────────────────────────────────
test('A1 真 报错箱.md 内容首跑基线到 EOF：15:00 测试行不回放、偏移文件落盘', async () => {
  const dir = freshDir();
  // 真机现场拷贝：报错箱.md 尾行 = 15:00 测试条目（#46 判据a 真机复测现场）。
  // 文件万一被清（历史只进不留也不该红），退回写已知的 15:00 测试行保住判据形状。
  const real = join(BOT, '报错箱.md');
  const content = existsSync(real)
    ? readFileSync(real, 'utf8')
    : '# 报错箱\n2026-10-09 15:00 插件版｜测试：#46 判据a 真机注入实测（主bot代发，无需处理）\n';
  assert.ok(content.includes('2026-10-09 15:00 插件版｜测试'), '真机现场必须含 15:00 测试行');
  writeFileSync(join(dir, '报错箱.md'), content);

  const calls = { injects: [], logs: [], errs: [] };
  const { createMailboxWatcher, MAILBOX_OFFSET_FILE } = await import(`${BOT}/src/mailbox.js`);
  const watcher = createMailboxWatcher({
    dir,
    lockPath: join(dir, '.mailbox.lock'),
    inject: async (chatId, text) => {
      calls.injects.push({ chatId, text });
      return { ok: true };
    },
    chatId: () => -5334440553,
    log: (m) => calls.logs.push(m),
    error: (m) => calls.errs.push(m),
  });
  try {
    assert.equal(watcher.start(), true, '干净环境下必须选主成功');
    await until(() => watcher.state.baselined, 3000, '首跑基线');
    await until(() => existsSync(join(dir, MAILBOX_OFFSET_FILE)), 3000, '偏移文件落盘');
    assert.equal(calls.injects.length, 0, '基线到 EOF：历史（含 15:00 测试行）必须零注入');
    const saved = JSON.parse(readFileSync(join(dir, MAILBOX_OFFSET_FILE), 'utf8'));
    assert.equal(saved.offset, Buffer.byteLength(content, 'utf8'), '偏移必须=真机文件字节数（932B 现场即 932）');
    assert.ok(calls.logs.join('\n').includes('历史不回放'), '基线日志必须声明历史不回放');
    // 基线之后追加新行 → 才注入，且只有新行。
    const newline = '2026-10-09 16:00 插件版｜基线后新报错（A1 测试）\n';
    appendFileSync(join(dir, '报错箱.md'), newline);
    await watcher.tick();
    assert.equal(calls.injects.length, 1, '基线后新行必须注入');
    assert.ok(calls.injects[0].text.includes('📬 报错箱新条目：'), '注入文本必须是「📬 报错箱新条目」信封');
    assert.ok(calls.injects[0].text.includes('基线后新报错'), '注入内容必须是新行原文');
    assert.ok(!calls.injects[0].text.includes('15:00'), '历史测试行不许混进注入');
  } finally {
    watcher.stop();
  }
});

// ── B 组：bot.js 接线静态断言 ─────────────────────────────────────────────
const bot = readFileSync(`${BOT}/bot.js`, 'utf8');
const pluginSrc = readFileSync(`${BOT}/src/index.js`, 'utf8');
const mailboxSrc = readFileSync(`${BOT}/src/mailbox.js`, 'utf8');
const pkg = JSON.parse(readFileSync(`${BOT}/package.json`, 'utf8'));
const setupdsh = readFileSync(`${BOT}/setupdsh.sh`, 'utf8');

function wiringBlock() {
  const start = bot.indexOf('// ---- 报错箱监听接线（#49');
  const end = bot.indexOf('// ---- 协作任务表轮询', start);
  assert.ok(start > 0 && end > start, 'bot.js 报错箱接线块切片失败（块不在或顺序不对）');
  return bot.slice(start, end);
}

test('B1 版本号两处同步：package.json=1.0.55、setupdsh.sh SPEC=v1.0.55', () => {
  assert.equal(pkg.version, '1.0.55');
  assert.match(setupdsh, /DSH-bot#v1\.0\.55/);
});

test('B2 bot.js 已 import mailbox 唯一权威源（不复制第二份，第 1 条）', () => {
  assert.match(bot, /import \{ createMailboxWatcher \} from '\.\/src\/mailbox\.js';/);
  // 注入文本「📬 报错箱新条目」只许活在权威源里。
  assert.ok(mailboxSrc.includes('📬 报错箱新条目：'), '权威源必须含注入信封');
  assert.ok(!bot.includes('📬 报错箱新条目'), 'bot.js 只许 import，不许复制注入文本');
});

test('B3 接线形状：master 门 + .mailbox.lock 选主 + 注入腿 submitTurn + chatId 兜底 + start', () => {
  const chunk = wiringBlock();
  assert.match(chunk, /let mailboxWatcher = null;/);
  assert.match(chunk, /if \(BOT_ROLE === 'master'\) \{/, '必须挂在 master 门内（worker 不开）');
  assert.match(chunk, /dir: APP_DIR/, '信箱目录必须是 bot 目录（与插件侧 herdDir 同一处）');
  assert.match(chunk, /lockPath: join\(APP_DIR, '\.mailbox\.lock'\)/, '选主锁必须落在 bot 目录');
  assert.match(chunk, /submitTurn\(chatId, \[\{ type: 'text', text \}\]\);/, '注入腿必须走 submitTurn（#45 同腿）');
  assert.match(chunk, /return \{ ok: true \}; \/\/ 进会话信箱 = 本腿完成/, '⛔ 必须回 {ok:true}，否则偏移永不推进死循环重投');
  assert.match(chunk, /const g = groupChatIdFromTable\(\);/, 'chatId 必须先取协作群');
  assert.match(chunk, /state\.ownerUserId/, '群 id 缺失必须兜底私聊 owner');
  assert.match(chunk, /mailboxWatcher\.start\(\);/, 'master 必须启动监听');
  assert.match(chunk, /本实例是 worker/, 'worker 分支必须落一行显式日志不静默');
});

test('B4 插件侧接线原样保留（将来迁插件架构仍可用）', () => {
  assert.ok(pluginSrc.includes('createMailboxWatcher({'), '插件侧 createMailboxWatcher 接线必须在');
  assert.ok(pluginSrc.includes("dir: herdDir,"), '插件侧 dir=herdDir 必须原样');
  assert.ok(pluginSrc.includes("lockPath: join(herdDir, '.mailbox.lock')"), '插件侧锁路径必须原样');
});

test('B5 shutdown 收尾：mailboxWatcher?.stop() 放锁（失败不连累关机）', () => {
  const start = bot.indexOf('function shutdown(signal)');
  const end = bot.indexOf('process.on(\'SIGINT\'', start);
  const body = bot.slice(start, end);
  assert.match(body, /mailboxWatcher\?\.stop\(\);/, 'shutdown 必须收尾报错箱监听');
  assert.match(body, /try \{\s*mailboxWatcher\?\.stop\(\);/, '收尾必须包 try（锁异常不连累关机）');
});

// ── C 组：bot.js 接线块真实切片直驱（master/worker 双角色）────────────────
function makeHarness(role, dir) {
  const wiringStart = bot.indexOf('let mailboxWatcher = null;');
  const wiringEnd = bot.indexOf('// ---- 协作任务表轮询', wiringStart);
  assert.ok(wiringStart > 0 && wiringEnd > wiringStart, 'bot.js 报错箱接线块切片失败');
  const wiringChunk = bot.slice(wiringStart, wiringEnd);
  return import(
    'data:text/javascript,' +
      encodeURIComponent(`
import { createMailboxWatcher } from 'file://${BOT}/src/mailbox.js';
import { join } from 'node:path';
const CALLS = { submit: [], logs: [], errs: [] };
const GROUP_MODE = { groupId: '-5334440553' };
const state = { ownerUserId: 7934872283 };
const BOT_ROLE = ${JSON.stringify(role)};
const APP_DIR = ${JSON.stringify(dir)};
const _ts = () => 'TEST';
const groupChatIdFromTable = () => GROUP_MODE.groupId;
// 真 submitTurn 恒返回 undefined —— 注入腿必须自己回 {ok:true}，这里照真形状打桩。
const submitTurn = (chatId, blocks) => { CALLS.submit.push({ chatId, blocks }); return undefined; };
const console = { log: (m) => CALLS.logs.push(String(m)), error: (m) => CALLS.errs.push(String(m)) };
${wiringChunk}
export { CALLS, GROUP_MODE, state, mailboxWatcher };
`)
  );
}

test('C1 master 切片：start 起监听、基线零注入、新行经 submitTurn 注入且只一次', async () => {
  const dir = freshDir();
  writeFileSync(join(dir, '报错箱.md'), '# 报错箱\n2026-10-09 15:00 插件版｜历史行\n');
  const h = await makeHarness('master', dir);
  try {
    assert.ok(h.mailboxWatcher, 'master 角色必须创建监听器');
    await until(() => h.mailboxWatcher.state.baselined, 3000, '切片基线');
    assert.equal(h.CALLS.submit.length, 0, '基线（历史行）不许注入');
    appendFileSync(join(dir, '报错箱.md'), '2026-10-09 16:00 插件版｜C1 新报错\n');
    await h.mailboxWatcher.tick();
    assert.equal(h.CALLS.submit.length, 1, '新行必须恰投一次');
    assert.equal(h.CALLS.submit[0].chatId, -5334440553, '投递目标=协作群');
    assert.ok(h.CALLS.submit[0].blocks[0].text.includes('📬 报错箱新条目：'), '注入信封必须一字同款');
    assert.ok(h.CALLS.submit[0].blocks[0].text.includes('C1 新报错'), '注入内容=新行原文');
    await h.mailboxWatcher.tick();
    assert.equal(h.CALLS.submit.length, 1, '同一条不许重复注入（偏移推进）');
    assert.ok(h.CALLS.logs.join('\n').includes('[报错箱] 监听已挂'), '必须落 [报错箱] 启动日志行');
  } finally {
    h.mailboxWatcher?.stop();
  }
});

test('C2 空行 / # 注释 / 残行：不注入不崩；残行补全后照投', async () => {
  const dir = freshDir();
  writeFileSync(join(dir, '报错箱.md'), '# 报错箱\n');
  const h = await makeHarness('master', dir);
  try {
    await until(() => h.mailboxWatcher.state.baselined, 3000, 'C2 基线');
    appendFileSync(join(dir, '报错箱.md'), '\n# 这是注释行\n2026-10-09 16:01 插件版｜残行没写完');
    await h.mailboxWatcher.tick();
    assert.equal(h.CALLS.submit.length, 0, '空行/#注释/残行必须全不触发');
    appendFileSync(join(dir, '报错箱.md'), '，已补全\n');
    await h.mailboxWatcher.tick();
    assert.equal(h.CALLS.submit.length, 1, '残行补全后必须照投一次');
    assert.ok(h.CALLS.submit[0].blocks[0].text.includes('残行没写完，已补全'), '补全内容必须完整不截断');
  } finally {
    h.mailboxWatcher?.stop();
  }
});

test('C3 worker 切片：不起监听、落显式日志', async () => {
  const dir = freshDir();
  const h = await makeHarness('worker', dir);
  assert.equal(h.mailboxWatcher, null, 'worker 角色必须不开监听');
  assert.ok(h.CALLS.logs.join('\n').includes('报错箱监听不开'), 'worker 必须落显式日志不静默');
});

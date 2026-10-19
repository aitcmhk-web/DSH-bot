/**
 * test-progress-sentinel.mjs —— 进度哨兵自动起停（`src/progress-sentinel.js`）的离线自测。
 *
 * 跑法：node test-progress-sentinel.mjs
 *
 * 覆盖：
 *   ① 脚本不在 → 整体空转：不写盘、不拉进程、回合照跑
 *   ② 回合开始 → 写「在干活=true」＋首步骤＋两个时间戳，并拉一次哨兵
 *   ③ 已在跑（pid 还活着）→ 不重复拉第二个
 *   ④ 回合内刷步骤 → 只改「步骤」，`起始`/`上次报` 原样不动；文字没变不写盘
 *   ⑤ 收尾 → 写「在干活=false」＋收掉哨兵；幂等（收两次只动一次）
 *   ⑥ 收尾之后再刷步骤 → 无效（⛔ 不许对着空气改开关）
 *   ⑦ 写盘是「临时文件 + rename」原子替换；坏 JSON 当空对象读，不抛
 *   ⑧ 关闭开关（script=null）→ 空转
 *
 * ⛔ 不真起进程、不碰真盘：fs / spawn / kill 全是注入的假的。
 */

import assert from 'node:assert/strict';
import { createProgressSentinel, SENTINEL_DEFAULT_INTERVAL_MINUTES, SENTINEL_IDLE_STATE } from './src/progress-sentinel.js';

let 过 = 0; const 掛 = [];
const 断言 = (条, 名) => { if (条) { 过 += 1; console.log(`  ✓ ${名}`); } else { 掛.push(名); console.log(`  ❌ ${名}`); } };

/** 假盘：只活在内存里，记下每一次写与改名。 */
function 造假盘(初始 = {}) {
  const 文件 = new Map(Object.entries(初始));
  const 写记录 = [];
  const 改名记录 = [];
  return {
    文件, 写记录, 改名记录,
    exists: (p) => 文件.has(p),
    readFile: (p) => { if (!文件.has(p)) throw new Error(`ENOENT: ${p}`); return 文件.get(p); },
    writeFile: (p, 内容) => { 写记录.push(p); 文件.set(p, 内容); },
    rename: (从, 到) => { 改名记录.push([从, 到]); if (!文件.has(从)) throw new Error(`ENOENT: ${从}`); 文件.set(到, 文件.get(从)); 文件.delete(从); },
    /** 取状态文件（解析后）。 */
    状态: (p) => JSON.parse(文件.get(p)),
  };
}

/** 假进程表：拉起来的 pid 都登记着，杀了就划掉。 */
function 造假进程() {
  const 拉起 = []; const 杀掉 = []; let 下个pid = 4000;
  const 活的 = new Set();
  return {
    拉起, 杀掉, 活的,
    spawn: (命令, 参数, 选项) => { const pid = 下个pid++; 拉起.push({ 命令, 参数, 选项, pid }); 活的.add(pid); return { pid, unref: () => {} }; },
    kill: (pid, 信号) => { 杀掉.push([pid, 信号]); 活的.delete(pid); },
    isAlive: (pid) => 活的.has(pid),
  };
}

const 脚本 = '/工作区/哨兵.mjs';
const 状态档 = '/工作区/哨兵状态.json';

/** 造一套「脚本在、盘是假的、进程是假的」的哨兵。 */
function 造哨兵(额外 = {}) {
  const 盘 = 造假盘();
  const 进程 = 造假进程();
  const 日志 = [];
  const 哨兵 = createProgressSentinel({
    script: 脚本, stateFile: 状态档,
    now: () => Date.parse('2026-10-19T12:00:00.000Z'),
    exists: (p) => p === 脚本 || 盘.exists(p),
    readFile: 盘.readFile, writeFile: 盘.writeFile, rename: 盘.rename,
    spawn: 进程.spawn, kill: 进程.kill, isAlive: 进程.isAlive,
    log: (m) => 日志.push(m), error: (m) => 日志.push(`ERR:${m}`),
    ...额外,
  });
  return { 哨兵, 盘, 进程, 日志 };
}

console.log('① 脚本不在：整体空转');
{
  const 盘 = 造假盘();
  const 进程 = 造假进程();
  const 日志 = [];
  const 哨兵 = createProgressSentinel({
    script: 脚本, stateFile: 状态档,
    exists: () => false, readFile: 盘.readFile, writeFile: 盘.writeFile, rename: 盘.rename,
    spawn: 进程.spawn, kill: 进程.kill, isAlive: 进程.isAlive,
    log: (m) => 日志.push(m), error: (m) => 日志.push(`ERR:${m}`),
  });
  断言(哨兵.isReady() === false, '脚本不在 → isReady 为假');
  断言(哨兵.start('干活') === false, 'start 直接回 false');
  断言(哨兵.note('步骤') === false, 'note 无效');
  断言(哨兵.stop() === false, 'stop 无效');
  断言(盘.写记录.length === 0, '一个字节都没写盘');
  断言(进程.拉起.length === 0, '没拉进程');
  断言(日志.filter((m) => m.includes('未启用')).length === 1, '只提示一次「未启用」（不刷屏）');
}

console.log('② 回合开始：写开关 + 拉哨兵');
{
  const { 哨兵, 盘, 进程, 日志 } = 造哨兵();
  断言(哨兵.start('正在处理你刚发来的消息') === true, 'start 回 true');
  const 状态 = 盘.状态(状态档);
  断言(状态.在干活 === true, '在干活 = true');
  断言(状态.步骤 === '正在处理你刚发来的消息', `步骤写进去了（${状态.步骤}）`);
  断言(状态.起始 === '2026-10-19T12:00:00.000Z' && 状态.上次报 === '2026-10-19T12:00:00.000Z', '起始/上次报都是开工那一刻');
  断言(盘.写记录[0] === `${状态档}.tmp` && 盘.改名记录[0][1] === 状态档, '写盘＝先写 .tmp 再 rename（原子替换）');
  断言(进程.拉起.length === 1, '拉了一次哨兵');
  断言(进程.拉起[0].参数[0] === 脚本, `拉的是那个脚本（${进程.拉起[0].参数[0]}）`);
  断言(进程.拉起[0].选项.detached === true, 'detached 起（⛔ 不跟着回合生死）');
  断言(日志.some((m) => m.includes('进度哨兵已拉起')), '日志里有一行「已拉起」');
}

console.log('③ 已经在跑：不重复拉');
{
  const { 哨兵, 进程 } = 造哨兵();
  哨兵.start('第一轮');
  哨兵.stop();
  哨兵.start('第二轮');
  断言(进程.拉起.length === 2, '收掉之后下一轮会重新拉（2 次）');
  // 同一轮里再 start 一次（比如重发消息）：pid 还活着就不许再拉。
  哨兵.start('第二轮再来');
  断言(进程.拉起.length === 2, '同一轮里重复 start 不再拉第二个');
}

console.log('④ 回合内刷步骤：只动「步骤」那一格');
{
  const { 哨兵, 盘 } = 造哨兵();
  哨兵.start('回合开始');
  const 起始 = 盘.状态(状态档).起始;
  const 写前 = 盘.写记录.length;
  断言(哨兵.note('跑数据机全量回归自测') === true, 'note 有效');
  const 状态 = 盘.状态(状态档);
  断言(状态.步骤 === '跑数据机全量回归自测', '步骤换了');
  断言(状态.起始 === 起始 && 状态.上次报 === 起始, '起始/上次报原样没动（⛔ 不拿刷步骤当「报过」）');
  断言(盘.写记录.length === 写前 + 1, '写了一次盘');
  断言(哨兵.note('跑数据机全量回归自测') === false && 盘.写记录.length === 写前 + 1, '同一句话不重复写盘');
  断言(哨兵.note('   ') === false, '空白步骤不收');
  断言(哨兵.note('换一件事') === true && 盘.状态(状态档).步骤 === '换一件事', '换一句话继续刷');
}

console.log('⑤ 收尾：写停工 + 收掉哨兵（幂等）');
{
  const { 哨兵, 盘, 进程 } = 造哨兵();
  哨兵.start('干活');
  断言(哨兵.stop() === true, 'stop 干了活');
  const 状态 = 盘.状态(状态档);
  断言(状态.在干活 === false && 状态.步骤 === SENTINEL_IDLE_STATE.步骤, '状态回到空闲');
  断言(进程.杀掉.length === 1 && 进程.杀掉[0][1] === 'SIGTERM', '哨兵被 SIGTERM 收掉');
  断言(哨兵.stop() === false && 进程.杀掉.length === 1, '再 stop 一次幂等（不多杀）');
}

console.log('⑥ 收尾之后再刷步骤：无效');
{
  const { 哨兵, 盘 } = 造哨兵();
  哨兵.start('干活');
  哨兵.stop();
  const 写前 = 盘.写记录.length;
  断言(哨兵.note('收工后乱写') === false && 盘.写记录.length === 写前, '⛔ 收工后 note 一个字都不写');
  断言(盘.状态(状态档).在干活 === false, '状态仍是「停工」');
}

console.log('⑦ 坏 JSON 当空对象读，不抛');
{
  const 盘 = 造假盘({ [状态档]: '{坏掉的' });
  const 进程 = 造假进程();
  const 哨兵 = createProgressSentinel({
    script: 脚本, stateFile: 状态档,
    exists: (p) => p === 脚本 || 盘.exists(p),
    readFile: 盘.readFile, writeFile: 盘.writeFile, rename: 盘.rename,
    spawn: 进程.spawn, kill: 进程.kill, isAlive: 进程.isAlive,
    log: () => {}, error: () => {},
  });
  哨兵.start('干活');
  断言(哨兵.note('坏档后刷步骤') === true, '坏档不挡刷步骤');
  断言(盘.状态(状态档).步骤 === '坏档后刷步骤', '照常写回好 JSON');
}

console.log('⑧ 关闭开关 + 默认值口径');
{
  const { 哨兵 } = 造哨兵({ script: null });
  断言(哨兵.isReady() === false && 哨兵.start('干活') === false, 'script=null（sentinelEnabled:false）→ 空转');
  断言(SENTINEL_DEFAULT_INTERVAL_MINUTES === 20, `默认间隔 20 分钟（${SENTINEL_DEFAULT_INTERVAL_MINUTES}）—— 必须 < 25 的铁律`);
  // 非默认间隔要传给哨兵（哨兵自己按 --间隔 决定拍子）。
  const { 哨兵: 哨兵2, 进程: 进程2 } = 造哨兵({ intervalMinutes: 15 });
  哨兵2.start('干活');
  断言(进程2.拉起[0].参数.includes('--间隔=15'), `非默认间隔走参数（${进程2.拉起[0].参数.join(' ')}）`);
  const { 哨兵: 哨兵3, 进程: 进程3 } = 造哨兵();
  哨兵3.start('干活');
  断言(!进程3.拉起[0].参数.some((a) => a.startsWith('--间隔=')), '默认间隔不加参数（哨兵自己的默认就是 20）');
}

console.log(`\n进度哨兵自测：过 ${过} 项，不过 ${掛.length} 项`);
if (掛.length) { console.log('挂的：'); for (const g of 掛) console.log(`  ❌ ${g}`); process.exit(1); }
assert.ok(true);
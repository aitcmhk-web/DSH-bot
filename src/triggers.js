/**
 * src/triggers.js — 主 bot 侧任务表自动触发（任务 #33，2026-10-08）。
 *
 * 等价搬家：这段能力原本只活在 bot.js（bot.js:1489 watchTaskTable），
 * 主 bot 正迁插件架构（mybot profile 已装本插件包），bot.js 退役后
 * 「待验收 → 验收轮」「待审核+通过标记 → 发版轮」这两条自动触发会整体失联
 * （实证：插件 v1.0.37 源码「待验收」零触发代码；#32 看门狗同病同搬）。
 * 这里按**同判据**在插件运行时重建：
 *
 *   每 5 分钟扫一次（与 #32 看门狗同拍：TRIGGER_CHECK_MS = HERD_CHECK_MS，
 *   同值同源只此一份定义），两件事：
 *
 *   ① 「待验收」worker 行 → 群发「🔔 验收触发 #N」+ 行占位「验收中」
 *      → 验收 prompt 注入主 bot 会话（bot.js 原版 submitTurn 的插件等价：
 *      enqueue + promptFromHub，worker 领活同款通路）。
 *   ② 「待审核 + 通过标记」行 → 群发「🔔 发版触发 #N」+ 行占位「发布中」
 *      → 发版 prompt 注入主 bot 会话。
 *
 *   为什么群发之外**必须**注入：TG 平台不向 bot 投递任何 bot 的发言
 *   （官方 Bots FAQ，src/index.js 任务表块头注释同款结论）——群发那条
 *   「🔔 验收触发」主 bot 自己也收不到，光群发叫不醒会话；注入才是真正的
 *   叫醒腿。群发是老板可见的触发公告 + 留痕。
 *
 *   失败不丢（任务书判据「TG 发送失败要重试不丢」）：
 *   - announce 抛错 → 本轮整体放弃，行不动 → 下轮重扫重发（天然重试）。
 *   - inject 返回 {ok:false}（或抛错）→ 行回滚原状态 → 下轮重来。
 *   - 备案：announce 成功后占位/注入若遇并发改表，最坏重复一条公告，
 *     主 bot 重复验收一次无害（占位防覆盖见 setRowStatus）。
 *
 *   占位原则照旧（bot.js 同款）：状态被改掉 = 下轮不重扫，防重复触发。
 *   顺序与 bot.js 原版不同（先公告后占位）：5 分钟轮询下公告是 await 短窗，
 *   无重复触发风险，却换来「发送失败行不动 = 重试不丢」。
 *
 *   验收轮只认 worker 名下的行（bot.js findTaskRow 原判据：WORKER_NAMES 限定，
 *   「主bot直做」「插件版」的行不经此轮）；发版轮不限 owner（bot.js
 *   findApprovedRow 原判据：状态 + 通过标记，#20 后审核按钮覆盖所有行）。
 *
 *   角色门在 src/index.js 接线处：只有 BOT_ROLE=master 的实例 start
 *   （审核实例/worker 实例不设 BOT_ROLE → 不跑，验收/发版轮只归主 bot）。
 *   全机唯一保险：.trigger.lock 选主，复用 herd 的锁实现（同一份代码、
 *   不同的锁文件，⛔ 不复制第二份锁逻辑）。
 *
 * 依赖全部注入（读表/写表/公告/注入会话/群 id/日志），测试不用起真进程、
 * 不碰真表真 TG（test-triggers.mjs）。
 */

import { HERD_CHECK_MS, HERD_LOCK_STALE_MS, WORKER_NAMES, claimHerdLock, releaseHerdLock } from './herd.js';

/** 巡检节奏：与 #32 看门狗同拍（同值同源，别单方面改）。 */
export const TRIGGER_CHECK_MS = HERD_CHECK_MS;
/** 锁心跳陈旧阈值：同 herd 口径（半瘫接管）。 */
export const TRIGGER_LOCK_STALE_MS = HERD_LOCK_STALE_MS;

/** 通过标记（bot.js APPROVE_MARKER 同款，插件 recordBossApproval 写入的文本头）。 */
export const APPROVE_MARKER = '✅ 老板已通过（审核按钮';

/** 任务表数据行解析（bot.js parseRow 同款正则）：no / task / owner / status。 */
function parseRow(line) {
  return line.match(/^\|\s*(\d+)\s*\|([^|]+)\|\s*([^\s|]+)\s*\|\s*([^|]+?)\s*\|/);
}

/** 找第一个「负责=worker 且 状态=待验收」的行（bot.js findTaskRow(table,'待验收') 同款）。
 *  → { index, line, no, task, owner } 或 null。 */
export function findPendingReviewRow(table) {
  const lines = table.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = parseRow(lines[i]);
    if (m && WORKER_NAMES.includes(m[3]) && m[4] === '待验收') {
      return { index: i, line: lines[i], no: m[1], task: m[2].trim(), owner: m[3] };
    }
  }
  return null;
}

/** 找第一个「状态=待审核 且 结论列带通过标记」的行（bot.js findApprovedRow 同款，不限 owner）。
 *  → { index, line, no, task, owner } 或 null。 */
export function findApprovedRow(table) {
  const lines = table.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = parseRow(lines[i]);
    if (m && m[4] === '待审核' && lines[i].includes(APPROVE_MARKER)) {
      return { index: i, line: lines[i], no: m[1], task: m[2].trim(), owner: m[3] };
    }
  }
  return null;
}

/** 把行按列改状态（bot.js setTaskStatus 同款：按 | 拆分重建，不受任务文本影响；
 *  行已被别人动过 → 放弃返回 false，防覆盖）。 */
export function setRowStatus({ readTable, writeTable }, row, nextStatus) {
  const table = readTable();
  if (!table) return false;
  const lines = table.split('\n');
  if (lines[row.index] !== row.line) return false; // 行已被别人动过：放弃本轮，防覆盖
  const cells = lines[row.index].split('|'); // ['', no, task, owner, status, note, '']
  if (cells.length < 6) return false;
  cells[4] = ` ${nextStatus} `;
  lines[row.index] = cells.join('|');
  writeTable(lines.join('\n'));
  return true;
}

/** inject 失败后的回滚：按 no 重新定位行（占位后 row.line 快照已旧），
 *  行仍是自己占的状态才翻回去（已被别人动 = 让位，不覆盖）。no 来自 (\d+) 捕获，纯数字。 */
export function rollbackRowStatus({ readTable, writeTable }, no, expectStatus, restoreStatus) {
  const table = readTable();
  if (!table || !/^\d+$/.test(String(no))) return false;
  const lines = table.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^\\|\\s*${no}\\s*\\|`).test(l));
  if (i < 0) return false;
  const cells = lines[i].split('|');
  if (cells.length < 6 || cells[4].trim() !== expectStatus) return false;
  cells[4] = ` ${restoreStatus} `;
  lines[i] = cells.join('|');
  writeTable(lines.join('\n'));
  return true;
}

/** 验收 prompt（bot.js watchTaskTable 原文一字不改；chatId 必为协作群）。 */
function reviewPrompt(row) {
  return [
    '<自动验收（系统触发，无需回复此段）>',
    `任务表 #${row.no}（负责=${row.owner}）进入「待验收」。任务：${row.task}`,
    '按职责验收：读改动（git diff / 相关文件）、跑测试；过了 → 任务表该行标「待审核」+ 填验收结论，群里公告「#N 验收通过，等审核」（⛔ 不发版——发版要等审核通过）；不过 → 标「打回」，结论写清哪里不行。',
    '结果发回协作群。',
    '</自动验收>',
  ].join('\n');
}

/** 发版 prompt（bot.js watchTaskTable 原文一字不改）。 */
function publishPrompt(approved) {
  return [
    '<审核通过（系统触发，无需回复此段）>',
    `任务表 #${approved.no}（负责=${approved.owner}）老板已在插件版审核按钮上点「✅通过」（群发那条 TG 平台不投递给 bot，本轮由任务表通过标记接力）。任务：${approved.task}`,
    '按协作约定发版：升版本号 → commit（message 带版本号）→ push → 打 tag → push --tags；任务表该行标「已发布」，结论列记发版版本与 tag；全程动作发回协作群。',
    '</审核通过（系统触发，无需回复此段）>',
  ].join('\n');
}

/** 一次扫描：① 待验收 → 公告+占位+注入；② 待审核+标记 → 公告+占位+注入。
 *  announce 抛错 = 本轮整体放弃（行不动，下轮重试不丢）。一轮只动一件事。 */
export async function triggerTick(deps) {
  const { readTable, writeTable, announce, chatId, inject, log = () => {}, error = console.error } = deps;
  const table = readTable();
  if (!table) return;

  // ① 「待验收」worker 行 → 验收轮
  const row = findPendingReviewRow(table);
  if (row) {
    try {
      await announce(`🔔 验收触发 #${row.no}`); // 发送失败 → 行不动不注入，下轮重试（不丢）
    } catch (err) {
      error(`[触发器] #${row.no} 公告发送失败（${err?.message ?? err}）—— 行不动，下轮重试`);
      return;
    }
    if (!setRowStatus({ readTable, writeTable }, row, '验收中')) return; // 占位失败（并发）：让位下轮
    const res = await Promise.resolve()
      .then(() => inject(chatId(), reviewPrompt(row)))
      .catch((err) => ({ ok: false, error: err?.message ?? String(err) }));
    if (!res?.ok) {
      rollbackRowStatus({ readTable, writeTable }, row.no, '验收中', '待验收');
      error(`[触发器] #${row.no} 验收轮注入失败（${res?.error ?? '?'}）—— 行已回滚「待验收」，下轮重试`);
      return;
    }
    log(`[触发器] #${row.no} 验收轮已触发（群公告 + 会话注入）`);
    return;
  }

  // ② 「待审核 + 通过标记」→ 发版轮（#25 接力的插件版，bot.js watchTaskTable 原判据）
  const approved = findApprovedRow(table);
  if (approved) {
    try {
      await announce(`🔔 发版触发 #${approved.no}`); // 同上：失败行不动，下轮重试
    } catch (err) {
      error(`[触发器] #${approved.no} 公告发送失败（${err?.message ?? err}）—— 行不动，下轮重试`);
      return;
    }
    if (!setRowStatus({ readTable, writeTable }, approved, '发布中')) return;
    const res = await Promise.resolve()
      .then(() => inject(chatId(), publishPrompt(approved)))
      .catch((err) => ({ ok: false, error: err?.message ?? String(err) }));
    if (!res?.ok) {
      rollbackRowStatus({ readTable, writeTable }, approved.no, '发布中', '待审核');
      error(`[触发器] #${approved.no} 发版轮注入失败（${res?.error ?? '?'}）—— 行已回滚「待审核」，下轮重试`);
      return;
    }
    log(`[触发器] #${approved.no} 发版轮已触发（群公告 + 会话注入）`);
  }
}

// ── 接线工厂：index.js 用它挂定时器（herd 工厂同款形状）──────────────────
/** deps = { lockPath, readTable, writeTable, announce, chatId, inject, log, error }
 *  返回 { start, stop, tick }；start 选主失败 = 别的实例在跑，本实例不开。
 *  启动即扫一轮（进程重启后立即补触发；已占位的行天然不会重触发）。 */
export function createTaskTriggers(deps) {
  let timer = null;
  let running = false; // 防重入：tick 内有 await（公告/注入），间隔内没跑完不许叠

  async function tick() {
    if (running) return;
    running = true;
    try {
      await triggerTick(deps);
    } catch (err) {
      deps.error?.(`[触发器] 轮询失败: ${err?.stack ?? err?.message}`);
    } finally {
      running = false;
    }
  }

  function start() {
    let c;
    try {
      c = claimHerdLock(deps.lockPath, Date.now());
    } catch (err) {
      deps.error?.(`[触发器] 选主失败（${err?.message}）—— 本实例不开触发轮询`);
      return false;
    }
    if (!c.won) {
      if (c.error) deps.error?.(`[触发器] .trigger.lock 不可用（${c.error}）—— 本实例不开触发轮询`);
      else deps.log?.(`[触发器] 已由别的实例看护（.trigger.lock 持有者 pid ${c.holder ?? '?'}），本实例不开`);
      return false;
    }
    if (c.tookOver) deps.log?.(`[触发器] .trigger.lock 是失联残留（pid ${c.holder ?? '?'}），本实例接管`);
    deps.log?.(`[触发器] 本实例接手任务表自动触发（pid ${process.pid}，每 ${TRIGGER_CHECK_MS / 60000} 分钟）`);
    void tick(); // 启动即扫一轮
    timer = setInterval(tick, TRIGGER_CHECK_MS);
    if (timer.unref) timer.unref();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    try {
      releaseHerdLock(deps.lockPath);
    } catch {
      /* 锁清理失败不连累卸载 */
    }
  }

  return { start, stop, tick };
}

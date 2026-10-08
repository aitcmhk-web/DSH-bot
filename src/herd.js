/**
 * src/herd.js — 小工看门狗（任务 #32，2026-10-08）。
 *
 * 等价搬家：这段能力原本只活在 bot.js 的 master 分支（bot.js watchWorkerHerd），
 * 主 bot 自 10-07 迁插件架构后跑的是本插件包，bot.js master 分支无人执行，
 * #9 小工看门狗整体失效（实证：#28 进行中 5.5 小时无人自动翻牌改派）。
 * 这里按**同判据**在插件运行时重建，函数名与 bot.js 版对齐，方便对照验收：
 *
 *   每 5 分钟巡检两件事：
 *   ① 小工存活：.bot.pid-00Xbot kill -0 **且** bot-00Xbot.log mtime 新鲜。
 *      光 pid 活 ≠ 活着（004bot 实案：pid 活着、日志停摆 12 分钟+）；小工侧每
 *      5 分钟写一行心跳（bot.js worker 角色自带），日志 15 分钟没动（心跳 ≥3 次
 *      缺席）才算假活 —— 把「健康空闲」和「假活」分开，防误报。
 *   ② 任务表进度：行「进行中/待领取」同状态 ≥30 分钟纹丝不动 = 停
 *      （首见只记时不判；只盯小工的行——待审核=等老板、待验收=主 bot、已发布=终态）。
 *      停摆的「进行中」行自动翻「待领取」+ 结论列注改派原因；「待领取」卡住只公告查小工。
 *
 *   判死/假活 → launchctl kickstart 拉活（与改派并行）。防风暴（#9 口径）：
 *   拉一次冷却 10 分钟、连拉 3 次无效 → 停手升级公告找老板；恢复后清记忆，边沿触发。
 *
 *   公告走协作群，一次巡检的所有结论合并成一条（createHerdWatchdog 的 announce）。
 *
 * 同拍复用（任务 #34，2026-10-08）：可选 deps.onHeartbeat 每 5 分钟一拍必调
 *   （主/从属实例都调），例行管理回合挂在它上面判「距上次 ≥30 分钟」触发，
 *   ⛔ 不另造定时器（第 1 条：同一件事只留一个权威源）。onHeartbeat 异常被
 *   隔离，带不垮巡检。
 *
 * 从属模式（#34 顺带补的 #32 缺口）：start 没抢到锁的实例**不再停掉定时器**
 *   ——原实现抢不到就 stop，一旦持锁者进程死透，全机再无人重试选主、看门狗
 *   整体失联直到从属进程重启。现在从属每拍重试 claim：持锁者活着只跑
 *   onHeartbeat 不巡检；持锁者死了自动接管（tookOver）升级回主。
 *
 * 依赖全部注入（root/读写表/公告/日志），测试不用起真进程、不碰真表；
 * kick 可打桩（绝不真跑 launchctl）。接线在 src/index.js（.herd.lock 选主）。
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';

/** 看护对象：四个小工（与 bot.js WORKER_NAMES 同名同序）。 */
export const WORKER_NAMES = ['001bot', '002bot', '003bot', '004bot'];

/** 巡检节奏与阈值（与 bot.js 同值，别单方面改，测试按这些值断言）。 */
export const HERD_CHECK_MS = 5 * 60 * 1000;
export const HERD_LOG_STALE_MS = 15 * 60 * 1000; // 3 次心跳缺席 = 假活
export const HERD_STALL_MS = 30 * 60 * 1000;
export const HERD_GROUP_FALLBACK = '-5334440553';
/** 拉活防风暴：拉一次后 10 分钟内不重复拉同一个小工；连拉 3 次不活 → 升级公告并停手。 */
export const REVIVE_COOLDOWN_MS = 10 * 60 * 1000;
export const REVIVE_MAX_REVIVES = 3;
/** .herd.lock 心跳超过 15 分钟没刷 = 持有实例半瘫（定时器不再走），别的实例可接管。 */
export const HERD_LOCK_STALE_MS = 15 * 60 * 1000;

// ── 存活判据（与 bot.js livenessVerdict 同一份判定，⛔ 别复制第二份）────────

export function workerPidPath(root, name) {
  return join(root, `.bot.pid-${name}`);
}
export function workerLogPath(root, name) {
  return join(root, `bot-${name}.log`);
}

/** kill -0 探活：EPERM = 进程在但无权发信号，也算活。 */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** 存活判据唯一实现：pidfile kill -0 **且** 日志 mtime 在 staleMs 内。健康返回 null。 */
export function livenessVerdict(name, pidPath, logPath, now, staleMs = HERD_LOG_STALE_MS) {
  let pid = NaN;
  try {
    pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  } catch {
    /* 无 pidfile */
  }
  if (!Number.isInteger(pid) || !pidAlive(pid)) {
    return `${name} 判死：pidfile 缺失或 pid ${pid || '?'} 已不在（kill -0 失败）`;
  }
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(logPath).mtimeMs;
  } catch {
    return `${name} 判假活：pid ${pid} 活着但日志 ${String(logPath).split('/').pop()} 不存在`;
  }
  const staleMin = Math.round((now - mtimeMs) / 60000);
  if (now - mtimeMs > staleMs) {
    return `${name} 判假活：pid ${pid} 活着，但日志已 ${staleMin} 分钟没动（心跳 ≥3 次缺席）`;
  }
  return null;
}

/** 单个小工存活检查。健康返回 null；否则返回「谁+判据+多久没动」一句话。 */
export function checkWorkerAlive(root, name, now, staleMs) {
  return livenessVerdict(name, workerPidPath(root, name), workerLogPath(root, name), now, staleMs);
}

/** 小工的 launchd 服务标签（bot.js 同款：com.local.dshbot.<name>）。 */
export function workerLaunchdLabel(name) {
  return `com.local.dshbot.${name}`;
}

/** 真 kick：launchctl kickstart -k gui/<uid>/com.local.dshbot.<name>（bot.js 同款）。 */
export function defaultWorkerKick(name, error = console.error) {
  const args = ['kickstart', '-k', `gui/${process.getuid()}/${workerLaunchdLabel(name)}`];
  const child = spawn('launchctl', args, { stdio: 'ignore' });
  child.on('error', (err) => error(`[herd] kickstart ${name} 失败: ${err.message}`));
}

// ── 拉活状态机（与 bot.js reviveDecide 同一份，⛔ 别复制第二份冷却/升级判定）──
/** 就地更新 state，返回一步决策：
 *  - isBad=true：'kick'（attempts 已 +1，调方负责真拉）/ 'cooldown'（期内静默）/
 *    'giveup'（连拉 MAX 次不活，已置 gaveUp，调方发升级公告）/ 'idle'（已放弃，静默）
 *  - isBad=false：'recovered'（曾放弃后恢复，重新纳入看护）/ 'reset'（普通清零）。 */
export function reviveDecide(state, isBad, now) {
  if (!isBad) {
    const wasGaveUp = state.gaveUp;
    state.badSince = null;
    state.attempts = 0;
    state.gaveUp = false;
    state.lastKickAt = 0;
    return { action: wasGaveUp ? 'recovered' : 'reset' };
  }
  if (!state.badSince) {
    state.badSince = now;
    state.attempts = 0;
  }
  if (state.gaveUp) return { action: 'idle' };
  if (state.attempts > 0 && now - state.lastKickAt < REVIVE_COOLDOWN_MS) return { action: 'cooldown' };
  if (state.attempts >= REVIVE_MAX_REVIVES) {
    state.gaveUp = true;
    return { action: 'giveup', attempts: state.attempts };
  }
  state.attempts += 1;
  state.lastKickAt = now;
  return { action: 'kick', attempts: state.attempts };
}

// ── 任务表操作 ────────────────────────────────────────────────────────────

/** 结论列时间戳：MM-DD HH:MM（本机时区，跟任务表既有留痕口径一致）。 */
function localStamp(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把一行翻「待领取」并在结论列追加改派原因（行被别人动过/不是进行中 → 放弃）。
 *  bot.js 同款逻辑，读写表走注入（两个进程共写一份文件，写入方负责原子替换）。 */
export function reassignTaskRow({ readTable, writeTable }, no, reason, now = Date.now()) {
  const table = readTable();
  if (!table) return false;
  const lines = table.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^\\|\\s*${no}\\s*\\|`).test(l));
  if (i < 0) return false;
  const cells = lines[i].split('|');
  if (cells.length < 6 || !WORKER_NAMES.includes(cells[3].trim())) return false;
  if (cells[4].trim() !== '进行中') return false;
  cells[4] = ' 待领取 ';
  const prev = cells[5].trim();
  cells[5] = ` ${(prev && prev !== '—' ? `${prev}；` : '') + `🐕 看门狗改派（${localStamp(now)}）：${reason}`} `;
  lines[i] = cells.join('|');
  writeTable(lines.join('\n'));
  return true;
}

/** 任务表数据行解析（bot.js 同款正则）：no / task / owner / status。 */
function parseRow(line) {
  return line.match(/^\|\s*(\d+)\s*\|([^|]+)\|\s*([^\s|]+)\s*\|\s*([^|]+?)\s*\|/);
}

// ── 一次巡检 ──────────────────────────────────────────────────────────────

/** 状态（边沿记忆/进度快照/拉活状态）由 makeHerdState() 持有，跨 tick 保留。 */
export function makeHerdState() {
  return { alarmed: new Set(), progress: new Map(), revive: new Map() };
}

/**
 * 一次巡检：存活 + 进度，返回本次的结论数组（空 = 一切正常）。
 * deps = { root, readTable, writeTable, announce, log, error }；
 * kick 可注入（测试打桩，绝不真跑 launchctl），缺省用 defaultWorkerKick。
 */
export function herdTick(state, deps, now = Date.now(), kick) {
  const { root, readTable, writeTable, announce, log = () => {}, error = console.error } = deps;
  const realKick = kick ?? ((name) => defaultWorkerKick(name, error));
  const verdicts = [];

  // ① 存活（判死/假活 → 公告 + 拉活 + 改派，三者并行；恢复清记忆，边沿触发）
  for (const name of WORKER_NAMES) {
    const v = checkWorkerAlive(root, name, now);
    if (v) {
      if (!state.revive.has(name)) {
        state.revive.set(name, { badSince: null, attempts: 0, gaveUp: false, lastKickAt: 0 });
      }
      const d = reviveDecide(state.revive.get(name), true, now);
      const firstAlarm = !state.alarmed.has(`alive:${name}`);
      if (firstAlarm) state.alarmed.add(`alive:${name}`);
      if (d.action === 'kick') {
        verdicts.push(`${v} → 已 launchctl kickstart 拉活（第 ${d.attempts}/${REVIVE_MAX_REVIVES} 次）`);
        realKick(name);
      } else if (d.action === 'giveup') {
        verdicts.push(
          `🐕 看门狗升级：${v}；已连续拉活 ${d.attempts} 次无效 → 停止自动重试，请老板人工处理`,
        );
      } else if (firstAlarm) {
        verdicts.push(v); // 兜底：状态机本步没动作时首判也要报（防漏公告）
      }
      // 改派与拉活并行：名下「进行中」翻「待领取」（reassignTaskRow 只翻进行中行，天然幂等）
      const table = readTable();
      if (table) {
        for (const line of table.split('\n')) {
          const m = parseRow(line);
          if (m && m[3] === name && m[4] === '进行中') {
            verdicts.push(`#${m[1]}（${name}）→ 翻「待领取」改派`);
            reassignTaskRow({ readTable, writeTable }, m[1], `看门狗：${v}`, now);
          }
        }
      }
    } else {
      state.alarmed.delete(`alive:${name}`);
      const st = state.revive.get(name);
      if (st) {
        const d = reviveDecide(st, false, now);
        if (d.action === 'recovered') log(`[herd] ${name} 恢复 —— 重新纳入看护`);
        state.revive.delete(name);
      }
    }
  }

  // ② 进度：同状态 ≥30 分钟 = 停（快照首见只记时，不判）
  const table = readTable();
  if (table) {
    for (const line of table.split('\n')) {
      const m = parseRow(line);
      if (!m || !WORKER_NAMES.includes(m[3])) continue;
      const no = m[1];
      const status = m[4];
      if (status !== '进行中' && status !== '待领取') continue;
      const prev = state.progress.get(no);
      if (!prev || prev.status !== status) {
        state.progress.set(no, { status, since: now });
        continue;
      }
      const stuckMin = Math.round((now - prev.since) / 60000);
      if (now - prev.since < HERD_STALL_MS || state.alarmed.has(`stall:${no}:${status}`)) continue;
      state.alarmed.add(`stall:${no}:${status}`);
      if (status === '进行中') {
        verdicts.push(`#${no}（${m[3]}）停摆：「进行中」已 ${stuckMin} 分钟纹丝不动 → 翻「待领取」改派`);
        reassignTaskRow({ readTable, writeTable }, no, `看门狗：进行中 ${stuckMin} 分钟无进展，自动改派`, now);
      } else {
        verdicts.push(`#${no}（${m[3]}）卡住：「待领取」已 ${stuckMin} 分钟没人领 → 查小工是否全趴`);
      }
    }
  }

  // ③ 公告：一次巡检的所有结论合并成一条发协作群（sendRich 由接线方提供）
  if (verdicts.length > 0) {
    error(`[herd] ${verdicts.join('；')}`); // 判据：主 bot（插件运行时）日志出 [herd] 播报
    const text = `🐕 看门狗播报：\n${verdicts.map((v) => `· ${v}`).join('\n')}`;
    void Promise.resolve()
      .then(() => announce(text))
      .catch((err) => error(`[herd] 公告发送失败: ${err?.message ?? err}`));
  }
  return verdicts;
}

// ── .herd.lock 选主（全机只许一个插件实例跑看门狗）────────────────────────
/** 拿锁/续心跳/接管三合一，幂等：
 *  - 文件不在 → wx 独占创建占锁（两个实例同时抢只有一个成功），won=true
 *  - 持有者是自己 → 刷新心跳，won=true
 *  - 持有者活着且心跳新鲜（或缺心跳）→ 让位，won=false
 *  - 持有者活着但心跳停 > HERD_LOCK_STALE_MS（半瘫：定时器不再走）→ 接管，tookOver=true
 *  - 持有者已死/内容坏 → 接管，tookOver=true
 *  - 文件系统出错 → fail-closed：不跑看门狗（双重 kickstart 比没人看护更糟），won=false */
export function claimHerdLock(lockPath, now = Date.now()) {
  const serialize = () => `${JSON.stringify({ pid: process.pid, heartbeat: now })}\n`;
  try {
    writeFileSync(lockPath, serialize(), { flag: 'wx' });
    return { won: true, tookOver: false };
  } catch (err) {
    if (err?.code !== 'EEXIST') return { won: false, error: err?.message }; // fail-closed
  }
  let raw = '';
  try {
    raw = readFileSync(lockPath, 'utf8').trim();
  } catch (err) {
    return { won: false, error: err?.message };
  }
  let holder = { pid: NaN, heartbeat: NaN };
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      holder = { pid: Number(obj?.pid), heartbeat: Number(obj?.heartbeat) };
    } catch {
      holder = { pid: NaN, heartbeat: NaN }; // 内容坏 → 当残留接管
    }
  }
  if (holder.pid === process.pid) {
    writeFileSync(lockPath, serialize()); // 自己的锁：顺手续心跳
    return { won: true, tookOver: false };
  }
  if (Number.isInteger(holder.pid) && holder.pid > 0 && pidAlive(holder.pid)) {
    const stale = Number.isFinite(holder.heartbeat) && now - holder.heartbeat > HERD_LOCK_STALE_MS;
    if (!stale) return { won: false, holder: holder.pid };
    writeFileSync(lockPath, serialize()); // 半瘫接管：pid 在但心跳停了
    return { won: true, tookOver: true, holder: holder.pid };
  }
  const tookOver = raw !== '';
  writeFileSync(lockPath, serialize()); // 持有者已死 / 文件坏：残留，接管
  return { won: true, tookOver, holder: holder.pid };
}

/** 释放：只删自己的锁（内容核对，防误删别人的）。 */
export function releaseHerdLock(lockPath) {
  let raw = '';
  try {
    raw = readFileSync(lockPath, 'utf8').trim();
  } catch {
    return false;
  }
  try {
    const { pid } = JSON.parse(raw);
    if (pid !== process.pid) return false; // 已是别人的锁
  } catch {
    return false;
  }
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

// ── 接线工厂：index.js 用它挂定时器 ────────────────────────────────────────
/** deps = { root, lockPath, readTable, writeTable, announce, log, error, onHeartbeat? }
 *  返回 { start, stop, tick }；start 返回 false = 本实例不做巡检（从属模式：
 *  定时器仍挂着，每拍重试选主 + 跑 onHeartbeat，见头注释）。 */
export function createHerdWatchdog(deps) {
  const state = makeHerdState();
  let timer = null;

  /** 每拍的附带任务（#34 管理回合）：异常隔离，带不垮巡检/选主。 */
  function heartbeat() {
    if (!deps.onHeartbeat) return;
    try {
      deps.onHeartbeat(Date.now());
    } catch (err) {
      deps.error?.(`[herd] onHeartbeat 失败（不连累巡检）: ${err?.stack ?? err?.message}`);
    }
  }

  function tick() {
    // 每轮先确认看门狗还是自己的（claim 兼做心跳续期）。
    const c = claimHerdLock(deps.lockPath, Date.now());
    if (!c.won) {
      if (c.error) {
        // 文件系统出错：fail-closed（巡检与管理回合都停，双重 kickstart 比没人看护更糟）。
        deps.error?.(`[herd] .herd.lock 不可用（${c.error}）—— 停止巡检与附带任务`);
        stop();
        return;
      }
      // 从属拍：别人在看护，本拍只跑附带任务（管理回合），下拍再试选主。
      heartbeat();
      return;
    }
    if (c.tookOver) deps.log?.(`[herd] .herd.lock 前持有者（pid ${c.holder ?? '?'}）已失联，本实例接管`);
    heartbeat(); // 主实例也跑附带任务：管理回合跟着锁走，谁看护谁带拍
    try {
      herdTick(state, deps, Date.now());
    } catch (err) {
      deps.error?.(`[herd] 巡检失败: ${err?.stack ?? err?.message}`);
    }
  }

  function start() {
    let c;
    try {
      c = claimHerdLock(deps.lockPath, Date.now());
    } catch (err) {
      deps.error?.(`[herd] 看门狗选主失败（${err?.message}）—— 本实例不开巡检`);
      return false;
    }
    if (!c.won) {
      if (c.error) {
        deps.error?.(`[herd] .herd.lock 不可用（${c.error}）—— 本实例不开巡检`);
        return false;
      }
      // 从属模式：不停定时器（#32 缺口补丁）——持锁者死透后全机要有人接管。
      deps.log?.(`[herd] 看门狗由别的实例看护（.herd.lock 持有者 pid ${c.holder ?? '?'}），本实例转入从属拍（每拍重试选主，不巡检）`);
      timer = setInterval(tick, HERD_CHECK_MS);
      if (timer.unref) timer.unref();
      return false;
    }
    if (c.tookOver) deps.log?.(`[herd] .herd.lock 是失联残留（pid ${c.holder ?? '?'}），本实例接管`);
    deps.log?.(`[herd] 本实例接手小工看门狗（pid ${process.pid}，每 ${HERD_CHECK_MS / 60000} 分钟巡检）`);
    timer = setInterval(tick, HERD_CHECK_MS);
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

  return { start, stop, tick, state };
}

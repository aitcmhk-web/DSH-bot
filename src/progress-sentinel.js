/**
 * progress-sentinel.js —— 回合起止自动管「进度哨兵」。
 *
 * 背景（老板 2026-10-19 定）：老板那条 TG 对话**等一条回复满 30 分钟就超时**；一超时主进程
 *   后面发什么都送不出去，得老板先敲一句才接得上。而主进程干活是一整轮跑完才回话，中途没有
 *   闹钟 —— 卡在一个长动作（等模型、跑大自测）里时一个字都发不出去。故在**进程外**放一个小哨兵
 *   （项目根的 `哨兵.mjs`）：它读项目根的 `哨兵状态.json`，`在干活=true` 且距上次报够间隔，
 *   就用**主 bot 令牌**直接发一句「⏳ 还在干活：<步骤>（已跑 N 分钟）」续住那条窗口。
 *
 * 本模块负责**自动起停**（老板 2026-10-19 点单「第二条」）：第一版靠主进程自觉写开关、自觉起
 *   进程，**忘了起就等于没有**；现在由本模块在回合开始/收尾时自动写开关、拉进程、收进程。
 *
 * 契约（与 `哨兵.mjs` 对齐，改任一侧必须同步另一侧）：
 *   · 状态文件 = `{ 在干活, 步骤, 起始, 上次报 }`，三个时间是 ISO 串；
 *   · `在干活=false` → 哨兵自行退出；脚本/状态文件缺 → 本模块**整体空转**（⛔ 不影响回合）；
 *   · 间隔由哨兵自己按 `--间隔=<分钟>` 决定，不写进状态文件。
 *
 * 行为边界：⛔ 不落库、⛔ 不碰宿主配置、⛔ 不写状态文件以外的任何文件；写盘走
 *   「临时文件 + rename 原子替换」，免得哨兵读到半个 JSON。
 *
 * 依赖全部注入（fs / spawn / kill / now），测试不真起进程、不碰真盘（test-progress-sentinel.mjs）。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 哨兵默认间隔（分钟）：严格小于「25 分钟必须报一次」这条铁律，留出余量。 */
export const SENTINEL_DEFAULT_INTERVAL_MINUTES = 20;

/** 状态文件的空档（收工时写这个）。 */
export const SENTINEL_IDLE_STATE = Object.freeze({
  在干活: false,
  步骤: '（空闲）',
  起始: null,
  上次报: null,
});

/** pid 是否还活着（`kill(pid, 0)` 不真发信号，只做存在性检查）。 */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 默认杀进程：先礼后兵（SIGTERM）。⛔ 不动别的进程，只动自己拉起来的那个 pid。 */
function defaultKill(pid, signal = 'SIGTERM') {
  process.kill(pid, signal);
}

/**
 * 造一个哨兵管理器。
 *
 * @param {object} options
 * @param {string|null} options.script          哨兵脚本绝对路径（缺 = 空转）
 * @param {string|null} options.stateFile       状态文件绝对路径
 * @param {number}      [options.intervalMinutes] 传给哨兵的间隔分钟（默认 20）
 * @param {Function}    [options.log]           正常日志（一行一件事）
 * @param {Function}    [options.error]         异常日志（⛔ 不影响回合）
 * @param {Function}    [options.now]           取当前毫秒（测试注入）
 * @param {Function}    [options.exists]        存在性检查（测试注入）
 * @param {Function}    [options.readFile]      读文件（测试注入）
 * @param {Function}    [options.writeFile]     写文件（测试注入）
 * @param {Function}    [options.rename]        改名（测试注入）
 * @param {Function}    [options.spawn]         拉进程（测试注入）
 * @param {Function}    [options.kill]          杀进程（测试注入）
 * @param {Function}    [options.isAlive]       pid 存活检查（测试注入）
 * @returns {{start:Function,note:Function,stop:Function,isRunning:Function,isReady:Function}}
 *   `start(首步骤)` 回合开始：写开关 + 拉哨兵；`note(步骤)` 回合内刷步骤；
 *   `stop()` 收尾：写停工 + 收哨兵；`isRunning()`/`isReady()` 只读查询。
 */
export function createProgressSentinel(options = {}) {
  const {
    script = null,
    stateFile = null,
    intervalMinutes = SENTINEL_DEFAULT_INTERVAL_MINUTES,
    log = () => {},
    error = () => {},
    now = () => Date.now(),
    exists = existsSync,
    readFile = readFileSync,
    writeFile = writeFileSync,
    rename = renameSync,
    spawn: spawnFn = spawn,
    kill = defaultKill,
    isAlive = defaultIsAlive,
  } = options;

  // 脚本不在就没这回事：整体空转，回合照跑（别人的机器上不会有这个脚本）。
  const ready = Boolean(script && stateFile && exists(script));
  let child = null;
  let running = false;
  let lastStep = null;
  let warned = false;

  /** 原子写状态文件：先写 `<档>.tmp` 再 rename，避免读到半个 JSON。 */
  function writeState(next) {
    const tmp = `${stateFile}.tmp`;
    writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    rename(tmp, stateFile);
  }

  /** 读状态文件；读不到或坏掉当空对象（宁可重写，不抛）。 */
  function readState() {
    try {
      const parsed = JSON.parse(String(readFile(stateFile, 'utf8')));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** 拉哨兵进程：已有一个活着的就不重复拉（防上一轮残留 + 这一轮再起两个）。 */
  function spawnSentinel() {
    if (child?.pid && isAlive(child.pid)) return;
    try {
      const args = [script];
      if (Number(intervalMinutes) !== SENTINEL_DEFAULT_INTERVAL_MINUTES) {
        args.push(`--间隔=${Number(intervalMinutes)}`);
      }
      child = spawnFn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        cwd: dirname(script),
      });
      child.unref?.();
      log(`进度哨兵已拉起（pid ${child.pid}，间隔 ${intervalMinutes} 分钟）`);
    } catch (err) {
      child = null;
      error(`进度哨兵拉不起来（本轮没有代报，不影响回答）: ${err.message}`);
    }
  }

  return {
    /** 回合开始：写开关（含首步骤）+ 拉哨兵。返回是否真开工。 */
    start(step = '正在处理你刚发来的消息') {
      if (!ready) {
        if (!warned) {
          warned = true;
          log(`进度哨兵未启用（项目根没有 ${script ?? '哨兵.mjs'} 就算了，不影响回合）`);
        }
        return false;
      }
      const stamp = new Date(now()).toISOString();
      const text = String(step ?? '');
      try {
        writeState({ 在干活: true, 步骤: text, 起始: stamp, 上次报: stamp });
      } catch (err) {
        error(`进度哨兵状态写不进去（本轮没有代报，不影响回答）: ${err.message}`);
        return false;
      }
      running = true;
      lastStep = text;
      spawnSentinel();
      return true;
    },

    /**
     * 回合内刷「步骤」：只改 `步骤` 那一格，`起始`/`上次报` 原样留着
     * （`上次报` 是「主进程最后一次在窗口里说话」，由回合开始那一刻定）。
     * 文字没变就不写盘，省掉无意义的磁盘抖动。
     */
    note(step) {
      if (!running) return false;
      const text = String(step ?? '').trim();
      if (!text || text === lastStep) return false;
      const cur = readState();
      const stamp = new Date(now()).toISOString();
      try {
        writeState({
          在干活: true,
          步骤: text,
          起始: cur.起始 ?? stamp,
          上次报: cur.上次报 ?? stamp,
        });
      } catch {
        return false;
      }
      lastStep = text;
      return true;
    },

    /** 回合收尾（含各类失败早退）：写停工 + 收掉哨兵。幂等。 */
    stop() {
      if (!running) return false;
      running = false;
      lastStep = null;
      try {
        writeState({ ...SENTINEL_IDLE_STATE });
      } catch (err) {
        error(`进度哨兵状态收尾失败（下轮开工会重写，无实质影响）: ${err.message}`);
      }
      if (child?.pid) {
        try {
          kill(child.pid, 'SIGTERM');
        } catch {
          /* 哨兵自己看到「停工」也会退，杀不掉不算事 */
        }
      }
      child = null;
      return true;
    },

    isRunning: () => running,
    isReady: () => ready,
  };
}
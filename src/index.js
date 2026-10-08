/**
 * dsh-botplugin — Telegram / WeChat 接入层 + handoff 记忆衔接。
 *
 * 三样主要功能：
 *   ① Telegram 入口（长轮询）
 *   ② 微信入口（iLink 长轮询）
 *   ③ handoff（会话断开前把进展落盘，新会话读回来接上）
 *
 * 架构：插件活在 DSH 进程内部，直接调用 `ctx.agents`，没有子进程管理层。
 *
 * Cordis 插件约定：
 *   - 具名导出 `name` / `inject` / `Config` / `apply`，不要 default 导出
 *     （Loader 的 unwrapExports 靠具名导出保留插件身份）。
 *   - `inject` 列出依赖的服务名；服务齐了 `apply()` 才会被调用。
 *
 * 本插件不 import 任何 `@deepseek-ai/*` 内部包：需要的东�西
 * 全部经由 `ctx` 服务和本目录的本地实现拿。
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, openSync, appendFileSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schema } from './schema.js';
import { Telegram } from './telegram.js';
import { Weixin } from './weixin.js';
import { Memory } from './memory.js';
import { BotRuntime } from './runtime.js';
import { Hub, makeMessage, markAsHubOutput } from './hub.js';
import { buildRoutes, routeByKey, routeFor, describeRoute, isRouteFailure, reasoningEffortFor } from './models.js';
import { readWebLlmPiAi, readWebLlmDeepseek, webPatchPath } from './web-patch.js';
import { LiveStatus, describeTool } from './status.js';
import { transcribe, configure as configureAsr, currentBackend } from './asr.js';
import { installApprovalBridge } from './approval-bridge.js';
import { createHardRulesHandler, HARD_RULES_EVERY_N } from './hard-rules.js';
import { createSourceGuardInstaller } from './source-guard.js';
import { createHerdWatchdog, HERD_GROUP_FALLBACK } from './herd.js';
import { makeMgmtState, mgmtRoundTick, fireMgmtRound, MGMT_CHAT_KEY } from './mgmt-round.js';
import { createTaskTriggers } from './triggers.js';

/** Cordis 插件名。 */
export const name = 'botplugin';

/**
 * 依赖的服务。
 *
 * ⚠️ `agents` 是**硬依赖**：没有它这个插件没有任何意义（收进来的消息没法交给模型）。
 *    Cordis 会等它出现才调 `apply()`。
 *
 * ⚠️ `attachments` 也必须写进 inject —— 它不是"可选优化"，是图片能不能看的**前提**：
 *    Cordis 里 `ctx.attachments` 属性访问**受 inject 门禁**，没声明就抛
 *    `cannot get property "attachments" without inject`（2026-09-29 真机日志 19:56:18）。
 *    少了它，runtime.js 的 `#attachments()` 永远拿不到服务 → 发图必失败。
 *    声明后宿主没装 attachment 插件也不影响纯文字（拿不到时只在真有图片块才报错）。
 */
export const inject = ['agents', 'attachments'];

/** 插件配置。 */
export const Config = Schema.object({
  // ---- Telegram ----
  telegramToken: Schema.string().description('@BotFather 给的 token。留空 = 不启用 Telegram 入口'),
  telegramApiRoot: Schema.string().default('https://api.telegram.org')
    .description('Telegram API 地址。只有在自建反代/网关时才需要改'),
  telegramAllowedUsers: Schema.array(Schema.number()).default([])
    .description('白名单用户 ID。空数组 = 第一个人发消息的人自动成为主人'),

  // ---- 微信 ----
  weixinToken: Schema.string().description('微信 iLink 凭据 token（扫码后得到）。留空 = 不启用微信入口'),
  weixinApiRoot: Schema.string().description('微信 API 根地址，一般不用改'),
  weixinAccountFile: Schema.string().description('凭据文件路径（不想把 token 写进配置时用）'),
  weixinAllowedUserId: Schema.string().description('只接受这个微信用户的消息'),

  // ---- 模型路由 ----
  routes: Schema.array(Schema.any()).default([])
    .description('模型路由表。留空 = 跟随 web 端模型页（web profile 的 cordis.patch.yml）增减的模型与默认档'),
  defaultRouteKey: Schema.string().description('默认走哪条路由（仅手写 routes 时有效）'),

  // ---- 工作区与记忆 ----
  cwd: Schema.string().description('会话工作目录。留空 = 用 DSH 当前目录'),
  memoryDir: Schema.string().description('记忆目录（每项目独占）。不填 = 默认 <工作目录>/memory；显式填空串 = 关闭记忆'),
  memoryScript: Schema.string().description('共享的 cache-manager.mjs 路径。不填 = 用插件自带的 vendor/conversation-cache/cache-manager.mjs'),
  restartCommand: Schema.string().description('重启用的启动器 .command 路径。不填 = 自动找工作目录里的 `start.command`（兼容老的「启动-<工作区名>.command」/启动-mybot.command）；找不到且拿不到原始命令行时，/restart 退化为只重开会话'),

  // ---- 行为 ----
  backlogMaxAgeSeconds: Schema.number().default(2 * 60 * 60)
    .description('停机太久时，超过这个年龄的积压消息不再执行（默认 2 小时）'),
  turnTimeoutMs: Schema.number().default(30 * 60 * 1000)
    .description('等模型回答的超时（毫秒，默认 30 分钟）。超时后该会话的队列才会解锁'),
  logLabel: Schema.string().default('botplugin').description('日志前缀'),

  // ---- 语音转文字 ----
  // 默认走 ali（线上 qwen3-asr-flash 优先，~0.6s；网关不在/出错自动回落本地 sensevoice，
  // 2026-10-07 老板定：默认顺序线上第一、本地第二）。本地路径留空会自动找 /opt/homebrew/bin 下的。
  // 线上不可用且本地也没装 → 收到语音时回「一条能直接粘的安装命令」，而不是 ENOENT。
  asrBackend: Schema.string().default('ali')
    .description('语音转文字后端：ali（默认，线上 qwen3-asr-flash ~0.6s，走模型网关，失败自动回退本地）、sensevoice（本地 FunASR，中文准）或 whisper（中文差，要用得显式填）'),
  asrWhisperBin: Schema.string().description('whisper 可执行文件路径（只有 asrBackend=whisper 时才用到）'),
  asrPythonBin: Schema.string().description('python 解释器路径（sensevoice 用，默认 /opt/homebrew/bin/python3.11）'),
  asrKeepalive: Schema.boolean().default(false)
    .description('是否启用常驻转写服务（省掉每次约 7 秒的模型加载，代价是常驻约 1.5GB 内存）'),
  asrKeepalivePort: Schema.number().default(18081).description('常驻服务端口'),
  asrKeepaliveScript: Schema.string()
    .description('常驻转写服务的脚本路径（asr-server.py）。不填则不用常驻'),
  asrMemoryLimitGb: Schema.number().default(16)
    .description('内存超过这么多 GB 就不启用常驻服务（避免和本地大模型抢内存）'),
  asrGatewayUrl: Schema.string().default('http://127.0.0.1:9310/call')
    .description('ali 后端用的模型网关 /call 地址（只有 asrBackend=ali 时用到）'),
  asrGatewayModel: Schema.string().default('阿里转文字')
    .description('ali 后端在网关模型表里的条目名（只有 asrBackend=ali 时用到）'),

  // ---- 识图自动探测 ----
  visionAutoDetect: Schema.boolean().default(true)
    .description('启动时后台自动探测各模型是否支持识图：通的继承识图，不通的自动标记纯文字（写 web 端模型配置，自动备份；不阻塞启动）'),
});

/** 日志小工具。 */
function makeLog(label) {
  const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  return {
    log: (line) => console.log(`[${ts()}][${label}] ${line}`),
    error: (line) => console.error(`[${ts()}][${label}] ${line}`),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 可被 abort 打断的 sleep。
 *
 * 为什么不用裸 sleep：拿不到单实例锁时要等 60 秒再重试，而宿主可能正好在这段
 * 等待里卸载插件（dispose）—— 裸 sleep 会让卸载卡在这个定时器上，「插件已卸载」
 * 迟迟不出现。abort 一到就立刻醒。
 */
const sleepAbortable = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });

/** 单实例锁的重试间隔：拿不到锁就每分钟来看一眼（持锁的那份退了就自动接上）。 */
const LOCK_RETRY_MS = 60 * 1000;

/**
 * 心跳多久不刷新 = 陈旧，可以接管。
 *
 * 为什么不能只看「pid 还活着」：进程活着 ≠ 在干活。
 *   getUpdates 挂死（黑洞 / 代理吞包）时进程活着、日志只有一行、消息全收不到，
 *   老逻辑却因为 pidAlive(pid) 为真而把锁让给它 —— 一份半瘫实例能永久霸着锁，
 *   重起的健康实例永远轮不上。90 秒 ≈ 3 个长轮询周期。
 */
const LOCK_STALE_MS = 90 * 1000;

/**
 * 单次 getUpdates 请求的硬超时。
 *
 * 为什么需要：调用方传进去的 signal 是**关停信号**（插件卸载时 abort），
 *   它只保证「卸载能立刻停」，不保证「请求不会永远挂着」。长轮询本该 30 秒返回，
 *   黑洞 / 代理吞包时 fetch 能挂到天荒地老 —— 进程活着、日志干净、消息全丢。
 *   45 秒 = 长轮询 30 秒 + 15 秒余量。
 */
const POLL_REQUEST_TIMEOUT_MS = 45 * 1000;

/**
 * 连续多少轮 getUpdates 失败（无成功收包）后自行 exit 非零，交外层拉起。
 *
 * 任务 #4（2026-10-07）：僵而不死的实例（进程活、消息全丢）只能靠人手工 TERM ——
 *   硬超时+重试解决「单次挂死」，但「持续失败」（网络长时间断 / 上游黑洞）时进程
 *   还会无限重试下去。连续 60 轮无成功（快速失败 ~3s/轮 ≈ 3 分钟；全部走满 45s
 *   超时 ≈ 45 分钟）就 exit(1)：launchd KeepAlive（SuccessfulExit=false）会把
 *   非零退出拉起来，等于自愈重启。409 冲突**不算**失败（对方在正常轮询，
 *   我们 exit 只会造成两实例互相拉扯，见 conflictStreak 分支）。
 */
const POLL_FAIL_EXIT_ROUNDS = 60;

/**
 * 把「关停信号」和「单次请求超时」合成一个信号。
 *
 * @param {AbortSignal|undefined} signal 关停信号（可空）
 * @param {number} timeoutMs 单次请求最长等待
 * @returns {AbortSignal|undefined}
 */
function withRequestTimeout(signal, timeoutMs) {
  // 老 Node 没有 AbortSignal.timeout/any 时退回原行为（至少关停还能停）。
  if (typeof AbortSignal?.timeout !== 'function') return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;
}

/**
 * 409 之后的重试间隔。
 *
 * 为什么是「暂停 + 重试」而不是停死：409 只说明**此刻**有别人在 getUpdates，
 * 对方随时可能自己退。停死则等于「进程活着但哑了」——systemd 的 Restart=always、
 * launchd 的 KeepAlive 都只对「进程退出」生效，没有任何托管者会来救它。
 */
const CONFLICT_RETRY_MS = 30 * 1000;

/** 409 时发给主人的通知：说人话 —— 发生了什么、我打算怎么做、你该去查什么。 */
const CONFLICT_NOTICE = '⚠️ 检测到另一个进程在用同一个 bot token（409）。我这边暂停轮询、稍后自动重试。如果机器人一直不回话，请检查是否有两份实例在跑（比如重复双击了启动器）。';

/** 单实例锁被别人持有时发给主人的通知（同上口径）。 */
const LOCK_BUSY_NOTICE = '⚠️ 检测到已有另一份实例在跑（单实例锁被占）。我这边先不轮询，每 60 秒重试一次，等它退出、或它的心跳停 90 秒（判定为收不到消息的半瘫）后自动接上。如果机器人一直不回话，请检查是否有两份实例在跑（比如重复双击了启动器）。';

/**
 * Telegram 返回 409 时另一个进程正在轮询同一个 bot token。
 *
 * ⚠️ 一个 token 只能有一个进程 —— 第二个进程会让先启动的那个收 409，
 *    表现就像 bot 随机不理人。
 *    插件运行在宿主进程里，不能 process.exit 拖垮整个 DSH，
 *    所以收到 409 只**暂停自己的轮询、稍后自动重试**（对方可能自己退），
 *    绝不停死：停死 = 进程还活着但不再收消息，日志里只有一行 409，
 *    而托管者只看「进程退出」，谁都不会来救 → 静默变哑。
 */
function isConflict(err) {
  return err?.errorCode === 409
    || /terminated by other getUpdates/i.test(String(err?.description ?? err?.message ?? ''));
}

/**
 * 单实例锁 —— 第 1 层防护：从源头避免 409。
 *
 * 为什么放在「开始轮询之前」：同一个 bot token 只允许一个进程 getUpdates。
 *   第二个进程会让先启动的那个收到 409；而 409 原先只停轮询、不退进程，
 *   于是机器人静默变哑、服务状态还显示 running。与其事后救火，不如先决出唯一。
 *
 * 判定规则（锁文件内容 = JSON `{pid, heartbeat}`）：
 *   - 文件不存在        → 独占创建（flag 'wx' 原子：两个实例同时启动也只有一个赢）；
 *   - pid 活着 + 心跳新鲜（< LOCK_STALE_MS）→ 让位：本次不轮询，由调用方 60 秒后再来；
 *   - pid 活着但心跳停了 → **半瘫**（进程在、消息收不到）→ 接管，不能让它霸着锁；
 *   - pid 已死 / 内容坏 / 就是自己 → 陈旧残留（断电、被 kill 留下的），直接接管；
 *   - 旧格式（一行纯数字、没有心跳）→ 按老规矩「pid 活着就让位」，不误抢。
 *
 * 心跳由**轮询进度**驱动（pollLoop 每成功收一轮就调一次 beat），不是独立定时器：
 *   进程活着但 getUpdates 挂死时，心跳自然停 —— 这才是「半瘫」的判据。
 *   若用心跳定时器，挂死的实例照样按时报平安，那就白做了。
 *
 * ⚠️ fail-open：锁相关的任何异常都不许把插件弄崩，也不许让 bot 彻底不工作 ——
 *    读不了写不了就记日志、当作拿到了锁继续跑，只是失去这层保护。
 *    宁可偶尔撞一次 409（第 2 层会兜住），也不要「锁坏了所以 bot 永远不说话」。
 *
 * @param {{lockPath: string, log: Function, error: Function}} opts
 */
export function createInstanceLock({ lockPath, log, error }) {
  /** 本实例是否认为自己持有锁（release 只在这个前提下才动手）。 */
  let held = false;

  /**
   * pid 是否活着。
   *
   * `process.kill(pid, 0)` 不发信号，只做存在性/权限检查。
   * ⚠️ 必须捕获异常：进程不存在时它抛 ESRCH，不捕获会把启动流程炸掉。
   */
  const pidAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM = 进程确实在，只是当前用户没权限给它发信号 → 也算活着（别抢）；
      // ESRCH = 没有这个进程 → 陈旧残留。
      return err?.code === 'EPERM';
    }
  };

  /** 本实例是否**真的写下了**锁文件（fail-open 时为 false，心跳也就没什么可刷的）。 */
  let ownsFile = false;

  /**
   * 读锁文件 → `{pid, heartbeat, raw}`。
   *
   * 新格式是 JSON；旧格式（一行纯数字 pid、没有心跳）照样认，只是 heartbeat = NaN
   * → 判定时退回「pid 活着就让位」，不误抢老实例的锁。
   * 内容坏掉 → pid = NaN → 走「陈旧残留、直接接管」。
   */
  async function readLock() {
    const raw = String(await readFile(lockPath, 'utf8').catch(() => '')).trim();
    if (!raw) return { pid: NaN, heartbeat: NaN, raw };
    if (raw.startsWith('{')) {
      try {
        const obj = JSON.parse(raw);
        return { pid: Number(obj?.pid), heartbeat: Number(obj?.heartbeat), raw };
      } catch {
        return { pid: NaN, heartbeat: NaN, raw };
      }
    }
    return { pid: Number.parseInt(raw, 10), heartbeat: NaN, raw };
  }

  /** 锁文件内容：pid + 心跳时间戳。 */
  const serialize = (pid) => `${JSON.stringify({ pid, heartbeat: Date.now() })}\n`;

  /**
   * 续心跳 / 查归属 —— 由 pollLoop 每轮调用。
   *
   * ⚠️ `refresh` 只有**收得到消息**的那一轮才为 true：心跳的语义是「我还在正常收消息」，
   *    超时/失败的一轮照样续期的话，半瘫实例又会按时报平安，那这套判定就白做了。
   *
   * ⚠️ 只刷新/认账「还是自己的」锁：这期间我们可能已被判陈旧、锁被别人接管，
   *    无脑重写会把新实例的锁覆盖掉 —— 那个新实例还以为自己独占，结果两个一起轮询。
   *
   * @param {boolean} [refresh] 是否顺手刷新心跳时间
   * @returns {Promise<boolean>} 锁是否仍在自己手上（false = 该让出轮询了）
   */
  async function beat(refresh = true) {
    if (!held) return false;
    if (!ownsFile) return true; // fail-open：没有文件可续，也谈不上被接管
    try {
      const { pid } = await readLock();
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        // 锁已经是别人的 → 认账，别再假装持有（继续轮询只会跟对方抢同一个 token）。
        held = false;
        ownsFile = false;
        error('单实例锁已被别的实例接管 —— 本实例停止续心跳，让出 Telegram 轮询');
        return false;
      }
      if (refresh) await writeFile(lockPath, serialize(process.pid));
      return true;
    } catch (err) {
      if (refresh) error(`刷新单实例锁心跳失败: ${err?.message}`);
      return true; // 读/写失败不判死，下次再看
    }
  }

  /** 尝试获取。true = 现在可以轮询（含 fail-open 的情况）。 */
  async function acquire() {
    try {
      try {
        // 'wx' = 独占创建：文件已存在就 EEXIST，绝不覆盖别人写的 pid。
        await writeFile(lockPath, serialize(process.pid), { flag: 'wx' });
        held = true;
        ownsFile = true;
        log(`已取得单实例锁（${lockPath}，pid ${process.pid}）`);
        return true;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
      }

      const { pid, heartbeat, raw } = await readLock();
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
        const staleMs = Date.now() - heartbeat;
        // 心跳新鲜 → 让位；心跳缺失（旧格式）也按老规矩让位，不误抢。
        if (!Number.isFinite(heartbeat) || staleMs < LOCK_STALE_MS) {
          log(`单实例锁被活着的 pid ${pid} 持有 —— 本实例先不轮询，${LOCK_RETRY_MS / 1000} 秒后再看`);
          return false;
        }
        error(
          `单实例锁的持有者 pid ${pid} 还活着，但心跳已停 ${Math.round(staleMs / 1000)} 秒`
            + `（超过 ${LOCK_STALE_MS / 1000} 秒 = 收不到消息的半瘫实例）—— 本实例接管（pid ${process.pid}）`,
        );
        await writeFile(lockPath, serialize(process.pid));
        held = true;
        ownsFile = true;
        return true;
      }

      // pid 是死的（僵尸残留）/ 内容坏掉 / 就是自己（不可能有两个同 pid 的进程）→ 接管。
      await writeFile(lockPath, serialize(process.pid));
      held = true;
      ownsFile = true;
      log(`单实例锁是陈旧残留（文件里的 pid：${raw || '(空)'}）—— 已接管（pid ${process.pid}）`);
      return true;
    } catch (err) {
      // fail-open：拿锁本身出问题，不能连累 bot 不工作。
      error(`单实例锁不可用（${err?.message}）—— 继续运行，只是失去这层保护`);
      held = true;
      ownsFile = false; // 没写下文件 → 不续心跳（beat 直接跳过），也不去删别人的锁
      return true;
    }
  }

  /**
   * 释放：**只删自己的锁**。
   *
   * ⚠️ 必须核对文件内容：这期间锁可能已被别的实例接管，
   *    无脑 unlink 会把新实例的锁删掉，等于把两个进程同时放进来。
   */
  async function release() {
    if (!held) return;
    held = false;
    if (!ownsFile) return; // fail-open 时没写过文件，也没什么可删
    ownsFile = false;
    try {
      const { pid } = await readLock();
      if (pid !== process.pid) return; // 已经是别人的锁 / 文件已不在
      await unlink(lockPath);
      log('已释放单实例锁');
    } catch (err) {
      if (err?.code !== 'ENOENT') error(`释放单实例锁失败: ${err?.message}`);
    }
  }

  return { acquire, release, beat, path: lockPath, get held() { return held; } };
}

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文
 * @param {object} config - 已校验的配置
 */
export function apply(ctx, config) {
  const { log, error } = makeLog(config.logLabel);
  const state = {
    stopped: false,
    ownerUserId: null,
    claimed: false,
  };

  // -------------------------------------------------------------------------
  // 路由表
  // -------------------------------------------------------------------------
  // ⚠️ 路由有两档来源：
  //    ① 配置里写了 routes → 用配置（手工表，优先）。
  //    ② routes 留空 → **跟随宿主模型表**（web 端模型页增减模型即时生效）：
  //       默认档 = 宿主 agentDefaultModel.currentSelection()（web 改默认模型，新会话就跟着变）；
  //       /model 列表 = 宿主 llm 目录 ∩ llm-pi-ai providers 的 models。
  //       宿主 API 依据：settings.get(ns)（dsh-settings/lib/index.js:388）、
  //       agentDefaultModel.currentSelection()（dsh-agent-default-model/lib/index.js:73）、
  //       llm.listProviders()（dsh-llm/lib/index.js:1846）。
  const { routes, defaultRouteKey, list: routeList } = buildRoutes(config.routes);
  const configuredDefault =
    (config.defaultRouteKey && routeByKey(routes, config.defaultRouteKey)?.key) ?? defaultRouteKey;
  let activeRoute = configuredDefault ? routeByKey(routes, configuredDefault) : null;
  const useHostRoutes = routeList.length === 0;
  // ⚠️ 跟随 web 端时「当前档位」与「web 端默认档」是**两件事**（2026-09-29 用户报障）：
  //    默认档只管「新会话从哪条路起步」，用户在菜单里切过之后，当前档位就该是切的那条。
  //    原先 refreshHostRoute() 每次刷写都把 activeRoute 覆盖成默认档，于是菜单的 ✅
  //    和 /status 永远指着默认模型（实际切换是成功的，只是显示被打回原形）。
  //    这里用一个显式记忆位承载「切过的档位」，刷新只在**没有记忆**时才回落到默认档。
  //  ⚠️ 记忆位光放内存会在**重启后丢**（2026-09-30 用户报障：「插件那边重启后模型
  //    又回默认的了」）—— 用户切过的档本该一直有效，直到他自己再切一次。所以落盘。
  //    存插件自己的文件，**刻意不碰 bot.js 的 .state.json**：那边 saveState() 是整体
  //    重写，两个进程各写各的会互相抹掉对方的状态。
  //
  //  ⚠️⚠️ 记忆位的存活判据**只能是「用户有没有再手选过」**（2026-09-30 用户定案：
  //    「不管什么原因，不要自动切换回第一档，除非我手动切换」）。
  //    原先这里拿「这个 key 在不在当前档位表里」当存活判据，出了一连串事故：
  //      · hostModelTable() 的第 ② 段（内置 deepseek 目录）不由 web 端配置决定，
  //        用户从 web 端删掉某个 ds 档，表里**照样有** → remembered 永远命中，
  //        清理分支永远不执行 → 旧 key 永久留存（2026-09-30 用户报障）。
  //      · 反过来，只要表有任何变动（web 端改默认、加减模型、升级、profile 重建），
  //        记忆档一时匹配不上就被判死并**落盘清空** → 重启后回第一档。
  //    ⇒ 现在记忆位是「粘」的：读到就信、就继续用，表里有没有都不影响它。
  //      进程重启 / 重启电脑 / 升级后重启**都不许动它**；只有 /model 手点那次才改。
  const pickedKeyFile = join(config.cwd || process.cwd(), '.botplugin-state.json');
  let hostPickedKey = null;
  // 每个 chat 当前在用的会话 id（2026-10-03 加）。`/new` 换 id 后必须记住，
  // 否则下一条消息又按老 id resume 回同一份历史 = 换了等于没换。
  // ⚠️ 和 hostPickedKey 同住一个文件，所以**写入只能走 writePluginState()**：
  //    两边各写各的整个 JSON 会互相抹掉（同 419 行那个教训）。
  const chatSessionIds = new Map();
  try {
    // 同步读：文件只有几十字节，且 apply() 不是 async（不能用 await）。
    const saved = JSON.parse(readFileSync(pickedKeyFile, 'utf8'));
    // ⚠️ 只认非空字符串。**不**在这里判"档位还有效吗" —— 见上面那段定案：
    //    有效性不该由插件猜，猜错一次用户的档位就没了。
    if (saved && typeof saved.hostPickedKey === 'string' && saved.hostPickedKey.trim()) {
      hostPickedKey = saved.hostPickedKey;
    }
    // 会话 id 同理：读到就信。读不到 = 这个 chat 没有（会现造一个新的）。
    if (saved && saved.sessions && typeof saved.sessions === 'object') {
      for (const [key, id] of Object.entries(saved.sessions)) {
        if (typeof id === 'string' && id) chatSessionIds.set(key, id);
      }
    }
  } catch { /* 文件不存在 / JSON 坏了 → 当没有记忆，照常回落默认档 */ }
  /** 落盘插件状态：模型记忆位 + 各 chat 的会话 id（唯一写入点）。 */
  const writePluginState = () => {
    try {
      writeFileSync(
        pickedKeyFile,
        JSON.stringify({ hostPickedKey, sessions: Object.fromEntries(chatSessionIds) }, null, 2),
      );
    } catch { /* 写不了不影响本次运行，只是重启后仍会回落 / 换新会话 */ }
  };
  /** 记住用户手选的档位（含落盘）。⚠️ 只该在用户**手点切换**时调用。 */
  const rememberPickedKey = (key) => {
    if (hostPickedKey === key) return;
    hostPickedKey = key;
    writePluginState();
  };

  // ── 宿主模型表：跟随 web 端「设置 → 模型」，加减模型即时生效 ──
  //    key 规则：单模型 provider 用别名，多模型 `<别名>:<模型id>`。
  // ⚠️ 2026-10-02：`dsa` = DeepSeek **账户**档（桌面版登录后 Web 端多出来的那一档）。
  //    和 `ds`（API key 档）**模型名完全一样**，只能靠 provider 区分，别想靠名字区分。
  const KEY_ALIAS = { alibailian: 'ali', 'deepseek-official': 'ds', 'deepseek-account': 'dsa', qwen36vq: 'local', qwen36iq4xs: 'iq4' };
  const menuKey = (pid) => KEY_ALIAS[pid] ?? pid;
  const routeKeyFor = (pid, modelId, isOnlyModel) => {
    const alias = menuKey(pid);
    return isOnlyModel ? alias : `${alias}:${modelId}`;
  };
  /**
   * 从记忆位的 key **重建**一个档位对象（web 端档位表里暂时找不到它时用）。
   *
   * 为什么需要：记忆位不再拿档位表校验（见 refreshHostRoute 的定案），于是
   * 「表里没有」时不能再靠 table.list 兜底 —— 没有这步重建，activeRoute 会变成
   * null，用户手选的档位在重启后等于消失（比"回第一档"更糟）。
   *
   * 规则与 routeKeyFor 同源（互为逆运算）：
   *   · `zhipu:glm-4.7-flash` → provider=zhipu, model=glm-4.7-flash
   *   · `ali`                 → 别名反查 provider=alibailian，model 未知 → 退回 last，
   *                             拿不到就返回 null（**不猜模型名**）
   *
   * @param {string} key 记忆位里的 key
   * @param {object|null} last 上一次解析出来的档位（用来补 model 等已知信息）
   * @returns {object|null} 重建的档位；信息不够就 null，绝不编一个假的
   */
  const routeFromPickedKey = (key, last) => {
    const colon = key.indexOf(':');
    let provider;
    let model;
    if (colon > 0) {
      const alias = key.slice(0, colon);
      model = key.slice(colon + 1);
      // 别名反查真实 provider id；反查不到就按原样当 provider id。
      provider = Object.keys(KEY_ALIAS).find((pid) => KEY_ALIAS[pid] === alias) ?? alias;
    } else {
      // 没有 `:` = 单模型 provider，key 本身就是别名（也可能用户手写过真 provider id）。
      provider = Object.keys(KEY_ALIAS).find((pid) => KEY_ALIAS[pid] === key) ?? key;
      // 模型名无从得知：只有 last 恰好在同一个 provider 上时才能沿用，否则放弃。
      if (last && last.provider === provider && last.model) model = last.model;
    }
    if (!provider || !model) return null;
    return {
      key,
      provider,
      model,
      // 这几个只用于显示；拿不到真实值就给个不含糊的占位，别假装知道。
      label: last?.provider === provider ? last.label : provider,
      short: last?.provider === provider ? last.short : `${provider}:${model}`,
      displayName: last?.provider === provider ? last.displayName : model,
      reasoningEffort: last?.provider === provider ? last.reasoningEffort : 'none',
      isDefault: false,
      // ⚠️ 标记"这不是从表里来的"，别处若要按表判断可以据此区分。
      __rebuiltFromPickedKey: true,
    };
  };

  /** 实时重建宿主模型表（异步：deepseek 内置目录要查 llm 服务）。 */
  const hostModelTable = async () => {
    const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
    const readSection = (ns) => {
      try { return settings?.get?.(ns) ?? {}; } catch { return {}; }
    };
    const live = new Set((llm?.listProviders?.() ?? []).map((p) => p.provider ?? p.id));
    const def = readSection('agent-default-model');
    const list = [];

    // ① 自定义 provider（llm-pi-ai.providers.*）
    //    ⚠️ 来源优先级（2026-09-30 定案）：**先读 web 端 patch 文件**，再退回 settings 服务。
    //    原因：patch 按 profile 隔离（`dsh-app-boot/lib/index.js:946,1141`
    //    `patchPath = join(dir, PROFILE_PATCH_FILENAME)`），插件跑在 bot profile 里，
    //    `settings` 服务读不到 web profile 那份；而别人机器上没有 `sync-from-web.mjs`
    //    去复制一份到 bot profile —— 只问 settings 的话，菜单会是**空的**。
    //    本机之所以看不出来，正是因为 sync 脚本帮着复制了一份。
    const fromWebPatch = readWebLlmPiAi();
    const providers = fromWebPatch ?? readSection('llm-pi-ai')?.providers ?? {};
    for (const [pid, p] of Object.entries(providers)) {
      const models = (Array.isArray(p?.models) ? p.models : []).filter((m) => m?.id);
      if (models.length === 0) continue;
      // ⚠️ 这里**刻意不**按 `llm.listProviders()` 过滤 —— 曾经写过
      //    `if (live.size > 0 && !live.has(pid)) continue;`，后果是：
      //    pi-ai 只在「provider 名单」变化时才重注册（dsh-llm-pi-ai/lib/index.js:2643
      //    ensureRegistrationFacts → provider 集合没变就直接 return），
      //    所以给**已有** provider 加模型、或 web 端刚加好 provider 还没重启时，
      //    这个 live 集合是**旧的**，新档位会被静默剔出菜单 —— 菜单里点得到、
      //    一切就 `SDK initialize failed: provider "zhipu" ...`（2026-09-28 实测）。
      //    settings 是配置的单一事实源，live 集合只配当「可选诊断」，不配当过滤器。
      const label = p?.displayName ?? pid;
      for (const m of models) {
        list.push({
          key: routeKeyFor(pid, m.id, models.length === 1),
          label,
          short: `${label}:${m.name ?? m.id}`,
          provider: pid,
          model: m.id,
          displayName: m.name ?? m.id,
          // ⚠️ 没声明就是**不发** reasoningEffort（undefined = 用模型自己的默认档）。
          //    原先是 `p?.reasoning ?? 'off'`，当场上线就炸：pi-ai 把 glm-5.3-flash 的
          //    thinkingLevelMap.off 钉成 null（只认 low/high/max），传 "off" 直接
          //    UNSUPPORTED_REASONING_EFFORT，SDK initialize failed、整档切不过去。
          //    ⛔ 别再用 undefined 表达"没声明"：JSON 会把值为 undefined 的键丢掉，
          //    读的人分不清"没声明"和"没看见"，于是又落回兜底值 —— 当天踩过两遍。
          //    统一写 'none'（= 一个字节都不发），与 sync-from-web.mjs 口径一致。
          reasoningEffort: p?.reasoning ?? 'none',
          isDefault: def?.provider === pid && def?.model === m.id,
        });
      }
    }

    // ② 内置 deepseek（llm-deepseek）。
    //    ⚠️ 来源优先级与 ① 完全一致（2026-10-01 定案）：**先读 web 端 patch 文件**，
    //    再退回自己 profile 的 settings。原先这里只读自己那份，于是 bot 菜单的
    //    deepseek 档比 web 端多（web 端只声明 1 档，bot profile 自己声明 3 档 →
    //    菜单凭空多两条），用户看到的「菜单多了」就是这么来的。
    //    web 端那段没声明 models 时才向 llm 服务查动态目录，最后才是空。
    const dsSection = readWebLlmDeepseek() ?? readSection('llm-deepseek') ?? {};
    const declared = (Array.isArray(dsSection.models) ? dsSection.models : []).filter((m) => m?.id);
    let dsModels = declared;
    if (dsModels.length === 0 && llm?.listModels) {
      try { dsModels = (await llm.listModels('deepseek-official')) ?? []; } catch { dsModels = []; }
    }
    if (dsModels.length > 0 && (live.size === 0 || live.has('deepseek-official'))) {
      for (const m of dsModels) {
        const id = m?.id ?? m;
        if (!id) continue;
        list.push({
          key: routeKeyFor('deepseek-official', id, dsModels.length === 1),
          label: '深度求索',
          short: `深度求索:${m?.name ?? id}`,
          provider: 'deepseek-official',
          model: id,
          displayName: m?.name ?? id,
          // 同上：deepseek 目录里 reasoningEffort 没配就是 'none' = 不发，交给模型默认。
          // 配了才发（bot 的 web 端 llm-deepseek.reasoningEffort: off 是显式配置）。
          reasoningEffort: dsSection.reasoningEffort ?? 'none',
          isDefault: def?.provider === 'deepseek-official' && def?.model === id,
        });
      }
    }

    // ③ DeepSeek **账户**档（dsh-base 内置的 dsh-llm-deepseek-account，provider = deepseek-account）。
    //
    //    用户 2026-10-02 要求：桌面版登录账户后 Web 端模型列表多出这一档，菜单要跟上。
    //
    //    ⚠️ 模型名和上面 ② 的 ds 档**一模一样**（两档同源，都是 dsh-llm-deepseek 的
    //       DEFAULT_MODELS；账户档的 Config 直接复用它）。区分只能靠 provider：
    //       key 前缀 `dsa:` vs `ds:`，菜单前缀 `DeepSeek Account` vs `深度求索`。
    //    ⚠️ **不能**读 web patch 找它：账户档的目录是登录后向服务端**动态发现**的，
    //       不落在任何配置文件里；web patch 里只有 llm-pi-ai 和 llm-deepseek 两段。
    //       所以这里问 llm 服务（listModels('deepseek-account')）—— 没登录 → 空 → 不出现。
    if (llm?.listModels) {
      try {
        const acctModels = (await llm.listModels('deepseek-account')) ?? [];
        for (const m of acctModels) {
          const id = m?.id ?? m;
          if (!id) continue;
          list.push({
            key: routeKeyFor('deepseek-account', id, acctModels.length === 1),
            label: 'DeepSeek Account',
            short: `DeepSeek Account:${m?.name ?? id}`,
            provider: 'deepseek-account',
            model: id,
            displayName: m?.name ?? id,
            // 账户档没有独立的 settings 段可读；与 ds 档同口径，'none' = 不发参数。
            reasoningEffort: 'none',
            isDefault: def?.provider === 'deepseek-account' && def?.model === id,
          });
        }
      } catch {
        // 账户档目录拿不到就跳过，绝不影响其它档位（未登录时就是这条路径）。
      }
    }

    // web 端默认档匹配不到（没设/已删）时退第一条，别让菜单空转。
    const defaultKey = list.find((r) => r.isDefault)?.key ?? list[0]?.key ?? null;
    return { list, defaultKey };
  };
  /** 每次派发前刷新（web 端加减模型/换默认，下一条消息就生效）。 */
  const refreshHostRoute = async () => {
    if (!useHostRoutes) return activeRoute;
    const table = await hostModelTable();
    // ⚠️⚠️ 记忆位最先判、且**无条件生效**（2026-09-30 用户定案：「不管什么原因，
    //    不要自动切换回第一档，除非我手动切换」）。
    //    这里**不再**拿 table.list 去校验 hostPickedKey —— 那正是历次「重启后回
    //    第一档」的根因：表一时匹配不上（web 端改默认/加减模型/升级/profile 重建）
    //    就被判死并落盘清空。用户手选过的档，只有用户自己能改。
    if (hostPickedKey) {
      // 表里有这条 → 直接用表里的完整定义（档位参数以 web 端为准，不拿旧快照）。
      const inTable = table.list.find((r) => r.key === hostPickedKey);
      // 表里没有，但本轮运行里它已经解析好了（上一次刷新就建好了）→ 沿用，别丢。
      const alreadyResolved = activeRoute?.key === hostPickedKey ? activeRoute : null;
      // ⚠️ 表里没有、且本轮还没解析过它 —— **必须自己把档位重建出来**，
      //    否则 activeRoute = null，用户手选的档位在重启后等于凭空消失
      //    （表现就是「重启又回第一档 / 显示(未配置)」）。
      //    原先这里靠 table.list 兜底，所以永远不会为 null；现在不靠表了，
      //    这步重建就必须显式做 —— 漏了它，本函数就从"回第一档"变成"没有档"，
      //    是更糟的回归（2026-09-30 实测：场景 ①②③ 全挂，改成重建后全绿）。
      activeRoute = inTable ?? alreadyResolved ?? routeFromPickedKey(hostPickedKey, activeRoute);
      runtime?.setDefaultRoute(activeRoute);
      return activeRoute;
    }
    // 没有记忆位（从没手选过 / 用户清过）才走默认档，这是"新会话从哪起步"的初始值。
    activeRoute = table.list.find((r) => r.key === table.defaultKey) ?? null;
    runtime?.setDefaultRoute(activeRoute);
    return activeRoute;
  };

  /**
   * 自动回退链：剩下的档位按顺序试，但**本地档永远排最后**兜底。
   *
   * 口径照抄 bot.js `fallbackChainAfter()`（README.md:164）：web 端生成的档位表
   * 把本地档排在最前，直接按列表顺序回退会「一欠费就先撞本地」
   * （2026-09-28 实际发生过：zhipu 余额不足 → 直接切到 LOCAL-VQ）。
   * ⚠️ 只影响回退顺序，`/model` 菜单的展示顺序不变。
   */
  const fallbackChainAfter = (brokenKey, list) => {
    const rest = list.filter((r) => r.key !== brokenKey);
    return [...rest.filter((r) => r.key !== 'local'), ...rest.filter((r) => r.key === 'local')];
  };

  /**
   * 当前档位被模型拒绝后，换一个能用的档位。
   *
   * ⚠️ **刻意不落盘**（口径同 bot.js `failOverRoute`）：自动切换是应急，不是用户的选择。
   *    原档位以后充值/恢复了，重启后还能重新用上；要是落了盘，一次临时欠费就会
   *    把用户手选的档永久改掉 —— 那正是 2026-09-30 「重启后模型回默认」报障的同类错误。
   *
   * @returns {Promise<{route:object,key:string}|null>} 换成功的档位，全试完仍失败则 null
   */
  const failOverRoute = async (chatKey, brokenKey, detail) => {
    // ⚠️ 按本文件既有口径取档位列表（1220/1403 行同款）：非跟随宿主时**不能**调
    //    hostModelTable() —— 那条路要问宿主要 web 端档位表，非宿主模式下没有。
    const list = useHostRoutes ? (await hostModelTable()).list : routeList;
    for (const route of fallbackChainAfter(brokenKey, list)) {
      try {
        // ⚠️ 必须传真实 chatKey：runtime 的会话是按 chat 存的，
        //    传 null 找不到记录，等于没切（会话还挂在旧档位句柄上）。
        const r = await runtime.switchRoute(chatKey, route);
        if (r && r.ok === false) {
          error(`[model] 自动回退到 ${route.key} 失败: ${r.error}`);
          continue;
        }
        activeRoute = route;
        log(`[model] ${brokenKey} 调用失败,自动切到 ${route.key}: ${String(detail).slice(0, 160)}`);
        return { route, key: route.key };
      } catch (err) {
        error(`[model] 自动回退到 ${route.key} 也失败: ${err.message}`);
      }
    }
    return null;
  };

  // -------------------------------------------------------------------------
  // 记忆（handoff）
  // -------------------------------------------------------------------------
  // 记忆默认「装上就开」：数据落在工作目录的 memory/，程序用插件自带的
  // vendor/conversation-cache/（别的机器上没有 DSH 仓库，程序必须随包自带）。
  // 用户显式填 memoryDir 就用他的；显式填**空串**才关闭（不填 = undefined = 用默认）。
  const vendorMemoryScript = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'vendor',
    'conversation-cache',
    'cache-manager.mjs',
  );
  const memoryDir = config.memoryDir === undefined
    ? join(config.cwd || process.cwd(), 'memory')
    : config.memoryDir || null;
  const memory = memoryDir
    ? new Memory({
        memoryDir,
        memoryScript: config.memoryScript || (existsSync(vendorMemoryScript) ? vendorMemoryScript : null),
        log,
        error,
      })
    : null;

  // -------------------------------------------------------------------------
  // 各接入层
  // -------------------------------------------------------------------------
  // 语音转文字：把配置灌进 asr 模块。**必须在任何语音消息到达之前**。
  configureAsr({
    backend: config.asrBackend,
    whisperBin: config.asrWhisperBin || null,
    pythonBin: config.asrPythonBin || null,
    keepaliveScript: config.asrKeepaliveScript || null,
    keepalivePort: config.asrKeepalivePort,
    keepaliveEnabled: config.asrKeepalive === true,
    memoryLimitGb: config.asrMemoryLimitGb,
    // 条件展开：schema 没给默认值的场合不能把 asr.js 里的默认口覆盖成 undefined
    ...(config.asrGatewayUrl ? { gatewayUrl: config.asrGatewayUrl } : {}),
    ...(config.asrGatewayModel ? { gatewayModel: config.asrGatewayModel } : {}),
  });

  const telegram = config.telegramToken
    ? new Telegram(config.telegramToken, { apiRoot: config.telegramApiRoot })
    : null;

  /**
   * 给主人发一条 Telegram 私聊通知（409、单实例锁被占这类「人必须知道」的事件）。
   *
   * ⚠️ 为什么要单独一个函数而不是复用 hub/端点：这些都是**轮询层面**的故障，
   *    发生在消息流之外，走 hub 会被队列和端点状态牵连。
   *
   * 约定：私聊里 chat id == user id（与 tgEndpoint 同款），所以只需要 ownerUserId。
   * - 没配 Telegram、或主人还没被认领（ownerUserId 为 null）→ 静默跳过，这不是错误：
   *   没有投递目标，硬发只会得到 400。
   * - ⚠️ 必须自己吞掉所有异常：通知失败绝不能反过来影响轮询主流程
   *   （否则「409 之后的告警」会变成新的崩溃点）。
   */
  async function notifyOwner(text) {
    if (!telegram || state.ownerUserId === null) return;
    try {
      await telegram.sendMessage(state.ownerUserId, text);
    } catch (err) {
      error(`通知主人失败: ${err?.message}`);
    }
  }

  /** 审批桥（在入口就绪后安装；见下方 installApprovalBridge）。 */
  let approvalBridge = null;
  /** 微信的 context_token 缓存：userId → token。入站消息带来新鲜的。 */
  // ⚠️ 必须在 Weixin 构造**之前**声明：构造函数会把下面的 onInvalidate
  //    闭包存起来，虽然它要到重连时才执行（那时已初始化完），但把声明
  //    放在使用点之后是靠 TDZ 侥幸，读代码的人会以为有 bug。
  const wxContextTokens = new Map();

  const weixin = new Weixin({
    apiRoot: config.weixinApiRoot || undefined,
    accountFile: config.weixinAccountFile || undefined,
    // 重连时清空 context_token 缓存（见下方 wxContextTokens）。
    onInvalidate: () => {
      wxContextTokens.clear();
      log('微信 context_token 缓存已清空（重连）');
    },
  });
  // 微信凭据：优先配置里的 token；没有则读凭据文件。
  const weixinReady = config.weixinToken
    ? weixin.adopt({ token: config.weixinToken, baseUrl: config.weixinApiRoot })
    : weixin.load();

  // -------------------------------------------------------------------------
  // 模型运行时
  // -------------------------------------------------------------------------
  const runtime = new BotRuntime({
    ctx,
    route: activeRoute,
    cwd: config.cwd || process.cwd(),
    // 会话 id 落盘口：`/new` 换新会话后要记住新 id，否则下一条消息又 resume 回旧会话。
    sessionIds: {
      get: (key) => chatSessionIds.get(key) ?? null,
      set: (key, id) => {
        chatSessionIds.set(key, id);
        writePluginState();
      },
    },
  });

  // -------------------------------------------------------------------------
  // 权限
  // -------------------------------------------------------------------------
  /**
   * 判断这个人能不能用。
   *
   * 白名单里的人天然可信：通过校验的同时认领主人锚点，后续微信入口才有投递目标。
   */
  function authorize(userId) {
    const allow = config.telegramAllowedUsers ?? [];
    if (allow.length > 0) {
      if (!allow.includes(userId)) return { ok: false, reason: 'not-allowed' };
      if (state.ownerUserId === null) {
        state.ownerUserId = userId;
        state.claimed = true;
        return { ok: true, claimed: true };
      }
      return { ok: true };
    }
    if (state.ownerUserId === null) {
      state.ownerUserId = userId;
      state.claimed = true;
      return { ok: true, claimed: true };
    }
    return state.ownerUserId === userId ? { ok: true } : { ok: false, reason: 'not-owner' };
  }

  // -------------------------------------------------------------------------
  // 节点（hub）—— 所有端点的唯一交汇点
  // -------------------------------------------------------------------------
  const hub = new Hub({
    log,
    // 入站：端点 → 节点 → ① DSH ② 其他所有端点
    onInbound: async (msg) => {
      // 所有端点统一走这一条路：任何来源都不做第二入口，避免漏派发。
      // ⚠️ 队列键必须带 source 前缀。只用 chatId 的话，TG 的 12345 和微信的
      //    12345 会排进同一条队列 —— 两个不相干的人互相阻塞。
      // 忙时合包（2026-10-06 用户定，TG 侧专用）：正在处理上一条时连发的几条
      //    先攒进信箱，等当前轮跑完合并成一条投出；空闲立刻处理，零等待。
      //    微信侧不动，仍走原 enqueue 串行。
      if (msg.source === 'tg') {
        submitTurn(msg);
        return;
      }
      await enqueue(`${msg.source}:${msg.chatId}`, () => promptFromHub(msg));
    },
  });

  /** 端点适配器。只管自己的协议：怎么收、怎么发、怎么渲染。 */
  const tgEndpoint = {
    id: 'tg',
    async send(msg) {
      if (!telegram || state.ownerUserId === null) return;
      // 私聊里 chat id == user id
      // ⚠️ 用 sendRich（markdown → HTML + 标签感知切分 + 超长回退），
      //    不是裸 sendMessage。裸发会让模型的 markdown 原样露出来（`**粗体**` 之类）。
      await telegram.sendRich(state.ownerUserId, msg.text);
    },
  };

  const wxEndpoint = {
    id: 'wx',
    lastSendError: null,
    async send(msg) {
      if (!weixin.enabled) return;
      // ⚠️ 目标解析优先级（与 endpoints/tg.js#send 对称，2026-09-19 实测踩坑）：
      //    TG 入站广播过来的消息 `chatId` 是 **Telegram 数字 id**（如 7934872283），
      //    直接拿去当微信 target 会 `ret=-1 invalid request`。
      //    所以只有来源是 wx 时才认 chatId，否则一律发到微信主人。
      const target = msg.source === 'wx' && msg.chatId != null ? msg.chatId : (config.weixinAllowedUserId || weixin.ownerWxUserId || state.ownerUserId);
      if (!target) throw new Error('微信端点没有可投递的目标');

      // ⛔ 不要写成 `msg.contextToken ?? this.lastContextToken`：
      //    hub.outbound() 造的消息（hub.js:145）**永远不带 contextToken**，
      //    所以那条回落分支等于「永远用缓存里那个陈旧的 token」→ 必然 ret=-2。
      //    只有端点自己入站时带上的 token 才新鲜，才值得传。
      const fresh = msg.source === 'wx' ? msg.contextToken : undefined;

      try {
        console.log(`[wx] send to ${target}: ${String(msg.text).slice(0, 50)}… (token=${fresh ? 'yes' : 'no'})`);
        await weixin.sendText(target, msg.text, fresh);
        this.lastSendError = null;
      } catch (err) {
        // ret=-2 = 服务端会话失效。
        // 策略：无论是否带了 token，都去掉 token 重试一次；同时触发 reconnect
        // 清除本地缓存（旧 token 不再污染后续发送）。通道恢复依赖用户入站消息
        // 带新鲜 context_token，reconnect 至少清了缓存让下次发送不再被旧 token 污染。
        if (/ret=-2/.test(err.message)) {
          console.warn(`[wx] sendText ret=-2，去掉 token 重试 + 清理缓存`);
          await weixin.reconnect().catch(() => {});
          await weixin.sendText(target, msg.text, undefined);
          this.lastSendError = null;
          return;
        }
        this.lastSendError = err.message;
        throw err;
      }
    },
  };

  if (telegram) hub.add(tgEndpoint);
  if (weixinReady) hub.add(wxEndpoint);

  // -------------------------------------------------------------------------
  // 审批桥：DSH 的 approval/request → Telegram 内联按钮
  // -------------------------------------------------------------------------
  // 卡片目标会话（#39，2026-10-08 老板定「提权申请也放在群里，和审核一样」）：
  // 协作群优先（任务表头「协作群 chat id」，审核卡 sendReviewCard / #33 triggers
  // chatId 同款先例），表头没写群 id 时回退 ownerUserId 私聊兜底（群 id 缺失不失联）。
  // ⚠️ ownerUserId 为 null（老板还没认领）时仍返回 null → 桥不接管，走失败关闭：
  //    群卡按钮回调不做身份门，未认领就发卡 = 群里一张谁点都生效的死卡，⛔ 不许兜。
  approvalBridge = installApprovalBridge({
    ctx,
    telegram,
    getChatId: () => {
      if (!telegram) return null;
      const group = groupChatIdFromTable();
      if (group) return Number(group);
      return state.ownerUserId !== null ? state.ownerUserId : null;
    },
    log,
    error,
  });

  // -------------------------------------------------------------------------
  // 最高指令（HARD-RULES.md）：每干若干步，就把原文重新顶进上下文
  // -------------------------------------------------------------------------
  // 用户 2026-10-02 定：不是「开头读过一次就算」，而是「每干若干步就再出现一次」，
  // 否则干着干着就忘了。2026-10-03 定：挂载点从 `tools/post-execute`（工具已经跑完才
  // 触发，第一次动手本身来不及约束）换成 `agent/pre-step`（模型这一步的请求发出之前），
  // 计数也从「按动手次数」改成「按步」—— 逻辑抽在 `src/hard-rules.js`，文件头写了机制
  // 和两个必须守住的坑（空转步不记账、双挂载按 `agent:turn:step` 去重）。
  // ⚠️ 文件在**启动时读一次**并缓存（用户 2026-10-02 定）—— 改完内容要重启 bot 才生效。
  const HARD_RULES_PATH = new URL('../HARD-RULES.md', import.meta.url);
  let hardRulesText = '';
  try {
    hardRulesText = readFileSync(HARD_RULES_PATH, 'utf8').trim();
  } catch {
    hardRulesText = '';
  }
  const hardRulesHandler = createHardRulesHandler({
    text: hardRulesText,
    everyN: HARD_RULES_EVERY_N,
    log: (msg) => log(msg),
  });
  if (hardRulesHandler !== null) {
    // ⚠️ 挂两份（ctx + ctx.root）：`agent/pre-step` 是 agent 作用域事件，
    //    插件根 ctx 通常收得到，但被挂到不相关 scope 下就会漏 —— 与
    //    approval-bridge.js 同款做法（理由见其文件头注释）。handler 内部按
    //    `agent:turn:step` 去重，所以两份不会重复注入。
    const targets = ctx.root && ctx.root !== ctx ? [ctx, ctx.root] : [ctx];
    let mounted = 0;
    for (const target of targets) {
      if (typeof target?.on !== 'function') continue;
      try {
        target.on('agent/pre-step', hardRulesHandler);
        mounted += 1;
      } catch (err) {
        log(`最高指令挂载失败: ${err?.message ?? err}`);
      }
    }
    log(`最高指令已挂载（${mounted} 处 / 第 1 步 + 每 ${HARD_RULES_EVERY_N} 步 / ${hardRulesText.length} 字）：${HARD_RULES_PATH.pathname}`);
  } else {
    log(`最高指令文件为空或不存在，跳过挂载：${HARD_RULES_PATH.pathname}`);
  }

  // -------------------------------------------------------------------------
  // 来源闸（source-guard）：结论不标来源就打回（拦截型）
  // -------------------------------------------------------------------------
  // 用户 2026-10-08 定：只靠「每若干步注入一次最高指令」是提示型，看不到就漏 ——
  // 要一道**拦得住**的闸。机制：`agent/turn-stopping` 在回合即将关闭时触发，此时
  // `agent.steer(...)` 会往 next-step inbox 塞消息，loop 重读 inbox 后**不关回合、再走一步**
  // （@deepseek-ai/dsh-agent-loop/lib/index.js:998-1005、809-811）—— 正好用来打回补档位。
  // 实现抽在 `src/source-guard.js`，文件头写了机制、「双挂载去重」「同回合只打回一次」两个坑。
  {
    const installSourceGuard = createSourceGuardInstaller({ log: (msg) => log(msg) });
    const sgTargets = ctx.root && ctx.root !== ctx ? [ctx, ctx.root] : [ctx];
    let sgMounted = 0;
    for (const target of sgTargets) {
      if (installSourceGuard(target)) sgMounted += 1;
    }
    log(`来源闸已挂载（${sgMounted} 处）：收尾未标来源档位会被打回补一次`);
  }

  // -------------------------------------------------------------------------
  // 排队：同一个会话的回合必须串行
  // -------------------------------------------------------------------------
  /** chatKey → Promise 链尾。 */
  const queues = new Map();

  /**
   * 把任务排进某会话的队列。
   *
   * 必须串行：agent.followup() 是排队语义，同一个 agent 同时收到两条 prompt 会交错。
   */
  function enqueue(chatKey, task) {
    const key = String(chatKey);
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => {
      error(`会话 ${key} 的任务失败: ${err?.stack ?? err?.message}`);
    });
    queues.set(key, next);
    // 队列空了就清掉，避免 Map 无限增长
    next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
    return next;
  }

  // -------------------------------------------------------------------------
  // 忙时合包（TG 侧专用，2026-10-06 用户定）
  //
  // 正在处理上一条消息时又连发的几条：不再一条一条各开一轮，而是先落进信箱，
  // 等当前这轮跑完，把积压的几条**合并成一条**投给模型（几条并作一次提问、
  // 一次回答）。空闲时发来的消息仍然立刻处理，零等待 —— 与消息窗口「打包
  // 间隔秒」那种固定等候是两回事。微信侧不动：那边仍走原 enqueue 串行。
  // ⚠️ 实际执行仍全部经由 enqueue(同一个会话队列) —— 合包只决定「何时投、
  //    投几条」，每会话串行的语义不破坏（wx 并入 tg:owner 的队列键也不变）。
  // -------------------------------------------------------------------------
  /** chatKey → { running, pending: Array<msg> }。 */
  const tgMailboxes = new Map();

  /** 多条消息合成一条：相邻文本块换行拼接；图片等非文本块按原顺序保留。 */
  function mergeMsgs(msgs) {
    if (msgs.length === 1) return msgs[0];
    const merged = [];
    for (const m of msgs) {
      const blocks = Array.isArray(m.raw?.blocks)
        ? m.raw.blocks
        : [{ type: 'text', text: String(m.text ?? '') }];
      for (const b of blocks) {
        const last = merged[merged.length - 1];
        if (b?.type === 'text' && last?.type === 'text') last.text = `${last.text}\n${b.text}`;
        else merged.push({ ...b });
      }
    }
    return makeMessage({
      source: msgs[0].source,
      chatId: msgs[0].chatId,
      text: merged.map((b) => b.text ?? '[图片]').join(' '),
      raw: { blocks: merged },
    });
  }

  async function drainMailbox(key, box) {
    try {
      while (box.pending.length > 0) {
        const batch = box.pending.splice(0);
        log(`[tg] 忙时合包：本轮合并 ${batch.length} 条消息为一次提问`);
        await enqueue(key, () => promptFromHub(mergeMsgs(batch)));
      }
    } finally {
      if (box.pending.length === 0) tgMailboxes.delete(key);
      else await drainMailbox(key, box).catch(() => {}); // 收尾间隙又来了新消息 → 继续清
    }
  }

  function submitTurn(msg) {
    const key = `${msg.source}:${msg.chatId}`;
    let box = tgMailboxes.get(key);
    if (!box) {
      box = { running: false, pending: [] };
      tgMailboxes.set(key, box);
    }
    box.pending.push(msg);
    if (box.running) return; // 忙：先攒着，等当前轮跑完由 drain 合并带走
    box.running = true;
    drainMailbox(key, box).catch((err) => error(`合包轮次失败: ${err?.stack ?? err?.message}`));
  }

  // -------------------------------------------------------------------------
  // 交给 DSH
  // -------------------------------------------------------------------------
  /** 记录每个 chatKey 的会话创建时间，handoff 判据要用。 */
  const sessionCreatedAt = new Map();

  /**
   * 会话键。微信消息并入**主人的 TG 会话**（与老 bot 的 owner anchor 同口径）：
   * TG 和微信聊的是同一段上下文，微信里 /new、/model 操作的也是同一个会话。
   * 主人还没认领时各归各（wx:xxx）。队列键在 hub.onInbound 里仍按源分开排，
   * 两个入口不会互相阻塞。
   */
  function hubChatKey(msg) {
    if (msg.source === 'wx' && state.ownerUserId !== null) return `tg:${state.ownerUserId}`;
    return `${msg.source}:${msg.chatId}`;
  }

  /**
   * 回合内的「活状态」：TG = 占位消息 + 打字续期 + 进度编辑；
   * 微信 = 只有「正在输入」（无编辑接口）。造不出来返回 null，退回干等。
   */
  function makeLiveStatus(msg) {
    try {
      if (msg.source === 'tg') {
        if (!telegram) return null;
        return new LiveStatus({ kind: 'tg', telegram, chatId: msg.chatId, log, error });
      }
      if (msg.source === 'wx' && weixin.enabled) {
        const contextToken = msg.raw?.context_token ?? wxContextTokens.get(String(msg.chatId));
        return new LiveStatus({
          kind: 'wx',
          weixin,
          wxUserId: String(msg.chatId),
          contextToken,
          log,
          error,
        });
      }
    } catch (err) {
      error(`活状态初始化失败(本轮没有进度显示,不影响回答): ${err.message}`);
    }
    return null;
  }

  /**
   * 把一条用户消息交给 DSH，并把回答送回来。
   *
   * ⚠️ **顺序至关重要**：`waitForTurn()` 必须在 `runtime.prompt()` **之前**订阅。
   *    反过来的话，建会话和跑第一轮之间有个窗口，快速回答的事件会在订阅前
   *    就发完 → 表现是「偶尔第一条消息没回答」，极难复现。
   *
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function promptFromHub(msg) {
    const chatKey = hubChatKey(msg);
    const text = String(msg.text ?? '').trim();
    // ⚠️ 空文本**不能**直接判死：带图无字的消息 `text` 是 `"[图片]"` 占位，
    //    但真正的图在 msg.raw.blocks 里。只有"既没字又没块"才是空消息。
    const inboundBlocks = Array.isArray(msg.raw?.blocks) ? msg.raw.blocks : null;
    if (!text && !inboundBlocks) return { ok: false, error: '空消息' };

    // 微信侧的命令解析：TG 在自己的入口里解析过了，这里补微信这一半
    // （老 bot 的 handleWeixinCommand 同款）。命令不进模型、不记账。
    if (msg.source === 'wx' && text.startsWith('/')) {
      const parts = text.split(/\s+/);
      const reply = (t) =>
        weixin
          .sendText(String(msg.chatId), t, wxContextTokens.get(String(msg.chatId)) ?? undefined)
          .catch((err) => error(`微信命令回话失败: ${err.message}`));
      const handled = await handleCommand(
        reply,
        msg.chatId,
        msg.chatId,
        chatKey,
        parts[0].toLowerCase().split('@')[0],
        parts.slice(1).join(' '),
        'wx',
      );
      if (handled) return { ok: true };
    }

    if (!sessionCreatedAt.has(chatKey)) sessionCreatedAt.set(chatKey, Date.now());
    memory?.ledgerRecord('user', text, chatKey);

    // 宿主模式下先刷新默认档 —— web 端加减模型/换默认，下一条消息就生效。
    await refreshHostRoute();

    const ep = msg.source === 'tg' ? tgEndpoint : wxEndpoint;

    // 回合内的「活状态」：TG = 占位消息 + 打字续期 + 进度编辑；
    // 微信 = 只有「正在输入」。造不出来就退回老样子（干等，不影响回答）。
    const status = makeLiveStatus(msg);
    if (status) await status.begin();

    // 冷启动记忆：会话还不存在（即将新建）= 上一段已随 /new、/restart、切模型
    // 或进程重启断开 —— 把 handoff 塞进第一条消息前面，模型不用用户复述上文。
    // 会话一旦存在 sessionIdOf 就非空，天然「每个会话只注一次」；
    // 记账在上一行已用原文落账，不受注入影响。
    //
    // ⚠️ 这里同时决定**送给 DSH 的是字符串还是内容块数组**：
    //    没有内容块（纯文字）→ 仍是字符串，路径与以前完全一致；
    //    有内容块（带图）→ 用块数组，冷启动记忆作为**第一个文本块**插到最前，
    //    顺序与注入字符串时相同（记忆在前、用户正文在后）。
    //    0.0.11 那次之所以没生效，就是因为图片块只塞进了 `msg.raw`，
    //    而这一行只把 `promptText`（字符串）送下去 —— 块从头到尾没被用过。
    const injectBoot =
      Boolean(memory) && runtime.sessionIdOf(chatKey) === null
        ? (memory.readBootstrapContext() ?? '')
        : '';
    let promptPayload;
    if (inboundBlocks) {
      promptPayload = [];
      if (injectBoot) {
        promptPayload.push({
          type: 'text',
          text: `<冷启动记忆（系统自动注入，无需回复此段）>\n${injectBoot}\n</冷启动记忆>`,
        });
      }
      promptPayload.push(...inboundBlocks);
      log(
        `[mem] 带内容块投递：${inboundBlocks.length} 块` +
          `${inboundBlocks.some((b) => b?.type === 'image') ? '（含图片）' : ''}` +
          `${injectBoot ? ' + 冷启动记忆' : ''}（${chatKey}）`,
      );
    } else {
      let promptText = text;
      if (injectBoot) {
        promptText = `<冷启动记忆（系统自动注入，无需回复此段）>\n${injectBoot}\n</冷启动记忆>\n\n${text}`;
        log(`[mem] 已注入冷启动记忆（${chatKey}）`);
      }
      promptPayload = promptText;
    }

    // ① 先订阅，后发消息
    const waiting = runtime.waitForTurn(chatKey, config.turnTimeoutMs);

    // 会话事件 → 活状态（工具动态 + 吐字速度采样），口径与老 bot 的 onSessionEvent 一致。
    const offEvents = status
      ? runtime.onSessionEvent((payload) => {
          const sid = runtime.sessionIdOf(chatKey);
          if (sid === null || payload?.sessionId !== sid) return;
          const { event } = payload ?? {};
          if (event?.type === 'tool/call') {
            status.addNote(describeTool(event.data?.name, event.data?.arguments));
            return;
          }
          if (event?.type === 'assistant/message') {
            const content = event.data?.message?.content;
            if (!Array.isArray(content)) return;
            const t = content
              .filter((b) => b?.type === 'text' || b?.type === 'reasoning')
              .map((b) => b.text ?? b.reasoning ?? '')
              .join('');
            if (t.trim()) {
              status.trackProgress(t.length);
              status.addNote(t);
            }
          }
        })
      : null;

    // ② 发给 DSH
    const sent = await runtime.prompt(chatKey, promptPayload);
    if (!sent.ok) {
      offEvents?.();
      await status?.fail(sent.error);
      error(`交给 DSH 失败（${chatKey}）: ${sent.error}`);
      await ep.send({ text: `❌ 处理失败：${sent.error}` }).catch(() => {});
      return sent;
    }

    // ③ 等回答
    const answer = await waiting;
    offEvents?.();
    if (!answer.ok) {
      // ⚠️ 余额不足/限额这类失败**不是这一轮的问题，是这个档位不能用了**
      //    （2026-09-30 用户报障：「模型欠费返回错误时，它不能自动跳到下一个模型」）。
      //    判定用 models.js 的 isRouteFailure（正则里已含 欠费/余额/额度/402/quota…），
      //    它此前只被 import 从没被调用 —— 这就是"判得出来却不切"的根因。
      //    网络抖动等临时故障（TRANSIENT_FAILURE）不切，免得白白丢掉上下文。
      if (isRouteFailure(answer.failure ?? answer.error)) {
        // ⚠️ 先记下**坏掉的档**再切 —— failOverRoute 会把 activeRoute 改成新档，
        //    切完再取就变成「从新档切到新档」的错话术（bot.js 同样先存 from）。
        const broken = activeRoute;
        const switched = await failOverRoute(chatKey, broken?.key, answer.error);
        if (switched) {
          await ep
            .send({
              text:
                `🔁 模型「${describeRoute(broken)}」不可用，` +
                `已自动切换到「${switched.route.label ?? switched.key}」并重试。\n原因：${answer.error}`,
            })
            .catch(() => {});
          // 在新档位上重发这一轮，然后照常等回答。
          const retry = await runtime.prompt(chatKey, promptPayload);
          if (retry.ok) {
            const retryWaiting = runtime.waitForTurn(chatKey, config.turnTimeoutMs);
            const retryAnswer = await retryWaiting;
            if (retryAnswer.ok) {
              const retryBody = retryAnswer.text || '(本轮没有文字输出)';
              memory?.ledgerRecord('assistant', retryBody, chatKey);
              // TG 端交付带 [DSH] 前缀
              const retryDeliver = msg.source === 'tg' ? '[DSH] ' + retryBody : retryBody;
              const retryTail = status ? await status.finish(retryDeliver) : null;
              if (!(status && msg.source === 'tg')) {
                const outText = retryTail ? `${retryBody}\n\n${retryTail}` : retryBody;
                await ep.send({ text: prefixReply(outText) }).catch((err) => error(`发送失败（${chatKey}）: ${err?.message}`));
              }
              // 广播到所有端点
              await hub.outbound(`[DSH] ${retryBody}`, { exclude: msg.source, label: 'DSH 输出' });
              return { ok: true };
            }
            await status?.fail(retryAnswer.error);
            await ep.send({ text: `❌ 换档后仍失败：${retryAnswer.error}` }).catch(() => {});
            return { ok: false, error: retryAnswer.error };
          }
          error(`换档后重发失败（${chatKey}）: ${retry.error}`);
        }
      }
      await status?.fail(answer.error);
      error(`等回答失败（${chatKey}）: ${answer.error}`);
      await ep.send({ text: `❌ ${answer.error}` }).catch(() => {});
      return { ok: false, error: answer.error };
    }

    const body = answer.text || '(本轮没有文字输出)';
    // 流水账记**不带小尾巴**的回答原文（老 bot 同口径：速度尾巴是采样元数据，不是对话）。
    memory?.ledgerRecord('assistant', body, chatKey);

    // TG 端交付需要带 [DSH] 前缀（与主程序 bot.js:1143 对齐）：
    // status.finish() 把回答编辑进 TG 占位消息，必须带前缀；
    // 微信端不走 ep.send() 时也会收到无前缀的 body，但微信有自己的广播路径。
    const prefixReply = (text) => {
      const t = String(text ?? '').trim();
      return t ? '[DSH] ' + t : t;
    };
    const deliverBody = msg.source === 'tg' ? prefixReply(body) : body;

    // 收尾交付：TG 由 status.finish 把回答（含速度小尾巴）**编辑进占位消息**（返回 null）；
    // 微信由 status 取消「正在输入」并返回小尾巴，回答照常走端点发送、小尾巴拼在后面。
    const tail = status ? await status.finish(deliverBody) : null;
    if (!(status && msg.source === 'tg')) {
      const outText = tail ? `${body}\n\n${tail}` : body;
      await ep.send({ text: prefixReply(outText) }).catch((err) => error(`发送失败（${chatKey}）: ${err?.message}`));
    }

    // 广播回答到所有端点（DSH → 节点 → 所有端点）
    // ⛔ 不要单独加前缀：hub.outbound 会广播到所有端点，发起端也会收到
    //    前缀统一在 hub.outbound 里加，与主程序版保持一致
    await hub.outbound(`[DSH] ${body}`, { exclude: msg.source, label: 'DSH 输出' });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Telegram 长轮询
  // -------------------------------------------------------------------------
  let offset = 0;
  let pollAbort = null;

  /**
   * Telegram 轮询主循环。
   *
   * 游标语义：
   *    - 不要用 getUpdates(-1)「探最新」—— 那等于告诉 Telegram 中间的更新
   *      都收到了，停机期间的消息会被静默丢弃。
   *    - offset 只在内存里：进程重启从当前时刻开始拉，不补发旧消息。
   *      要持久化应走 DSH 的存储服务，另开一轮做。
   */
  async function pollLoop() {
    if (!telegram) return;
    log('Telegram 轮询启动');
    /**
     * 连续冲突计数。
     *
     * 用途有二：① 通知节流（第 1 次 + 之后每 10 次一次）；② 成功轮询一次就归零 ——
     * 这样「冲突 → 恢复 → 再冲突」时，主人会重新立刻收到第 1 次通知，而不是被
     * 上一轮遗留的计数压到第 10 次才响。
     */
    let conflictStreak = 0;
    /** 连续失败轮数（收到包就归零；≥ POLL_FAIL_EXIT_ROUNDS 自退交外层拉起，见其注释）。 */
    let failStreak = 0;
    while (!state.stopped) {
      let updates;
      // 单实例锁是否仍在自己手上（收得到消息的那一轮才算数，见下面 beat）。
      let stillOurs = true;
      try {
        updates = await telegram.getUpdates(
          offset,
          30,
          withRequestTimeout(pollAbort?.signal, POLL_REQUEST_TIMEOUT_MS),
        );
        // 这一轮拿到了（哪怕是空数组）说明此刻没人和我们抢 → 冲突计数归零。
        conflictStreak = 0;
        failStreak = 0;
        // 收得到消息 = 还活着 → 续一次单实例锁的心跳（半瘫的实例得不到这一步）。
        // 若锁已被判陈旧、被别的实例接管：先把手上这批消息处理完，再让出轮询（见循环末尾），
        // ⛔ 不能在这一步直接 return —— 那会把已经取回来的消息丢掉。
        stillOurs = lock ? await lock.beat(true) : true;
      } catch (err) {
        if (state.stopped) break;
        if (isConflict(err)) {
          conflictStreak += 1;
          error('');
          error('❌ 409 Conflict：另一个进程正在用同一个 bot token 收消息。');
          error(`   本实例暂停轮询 ${CONFLICT_RETRY_MS / 1000} 秒后自动重试（不退出进程 —— 这里是宿主进程）。`);
          error('   常见原因：同一个 token 有别的进程在用（例如另一个 bot 或另一份插件）。');
          error('   ⛔ 同一个 token 只能有一个进程 —— 请只留一个。');
          // 通知节流：第 1 次 + 之后每 10 次一次，避免主人被每分钟一条刷屏。
          if (conflictStreak === 1 || conflictStreak % 10 === 0) {
            await notifyOwner(CONFLICT_NOTICE);
          }
          // ⚠️ 这里**不能 return**：对方可能下一秒就自己退了，停死等于永久哑掉。
          await sleep(CONFLICT_RETRY_MS);
          continue;
        }
        if (err?.name === 'TimeoutError') {
          // 单次请求超时：连接被吞了（黑洞 / 代理），必须断开重来 —— 挂死的实例永远收不到消息。
          error(`getUpdates 单次请求超时（${POLL_REQUEST_TIMEOUT_MS / 1000} 秒无响应）—— 断开这次连接，3 秒后重试`);
        } else if (!/abort/i.test(err.message ?? '')) {
          error(`getUpdates 失败: ${err.message}`);
        }
        // 关停中的 abort 不算失败；其余每轮失败记一笔，连续到阈值就自退交外层拉起
        //（任务 #4：僵而不死的实例不该等人工 TERM）。409 不进这个分支（上面已 continue）。
        if (!state.stopped && !/abort/i.test(err.message ?? '')) {
          failStreak += 1;
          if (failStreak >= POLL_FAIL_EXIT_ROUNDS) {
            const stillHolding = lock ? await lock.beat(false) : true;
            if (stillHolding) {
              error(`❌ 连续 ${failStreak} 轮 getUpdates 失败（无一次成功收包）—— 判定轮询已僵，exit(1) 交外层（launchd KeepAlive）拉起新实例`);
              process.exit(1);
            }
            return; // 锁已归别人：让对方轮询，本进程不陪葬
          }
        }
        // 这一轮没收到消息 → **不续心跳**（半瘫的判据），但顺手看看锁还是不是自己的。
        if (lock && !(await lock.beat(false))) return;
        await sleep(3000);
        continue;
      }

      let newest = null;
      let skippedStale = 0;
      for (const update of updates) {
        newest = update.update_id;

        // Telegram 保留 24 小时。执行一天前的请求比忽略它更糟（agent 有 shell 和文件权限），
        // 所以跳过，但要说出来，不静默丢。
        const sentAt = update.message?.date ?? update.callback_query?.message?.date;
        if (typeof sentAt === 'number' && Date.now() / 1000 - sentAt > config.backlogMaxAgeSeconds) {
          skippedStale += 1;
          continue;
        }

        if (update.message) {
          handleTelegramMessage(update.message).catch((err) =>
            error(`消息处理出错: ${err?.stack ?? err?.message}`),
          );
        }
        if (update.callback_query) {
          handleCallbackQuery(update.callback_query).catch((err) =>
            error(`按钮回调出错: ${err?.stack ?? err?.message}`),
          );
        }
      }

      if (skippedStale > 0) {
        error(`跳过 ${skippedStale} 条超过 ${Math.round(config.backlogMaxAgeSeconds / 3600)} 小时的积压消息`);
      }
      if (newest !== null) offset = newest + 1;

      // 锁已归别人（我们被判半瘫）→ 处理完这批就回外层重新排队，别跟它抢同一个 token。
      if (!stillOurs) {
        error('单实例锁已被别的实例接管 —— 让出 Telegram 轮询，回队伍重新排队');
        return;
      }
    }
  }

  /**
   * 处理一条 Telegram 消息。
   *
   * 统一路径：TG → hub.inbound → ① 交给 DSH ② 镜像到其他端点。
   *    不要写成对镜像（mirrorTgToWeixin 那种）—— 那是 O(n²)。
   */
  /** 本 bot 的 TG 用户名（群模式点名用，getMe 后填）。 */
  let tgBotUsername = null;

  async function handleTelegramMessage(message) {
    const chatId = message.chat.id;
    const userId = message.from?.id;

    // 打回原因条回复（任务 #20，2026-10-07）：老板对 ForceReply 原因条的回复必须在
    // 群模式过滤**之前**接住 —— 群里回复不带 @点名，走正常路径会被静默丢。
    // 返回 false = 不是这条线（或非老板），照旧往下走。函数体在审核块（#20）。
    if (await handleRejectReasonReply(message)) return;

    // ---- 群模式（2026-10-06 用户定；同日二次修订）----
    // 默认对话归主 bot：插件版在群里只接 ①@点名 ②任务表自动派活（见 watchTaskTable）。
    // 陌生人的消息静默忽略（⛔ 不把「已绑定别的用户」这种私聊提示发进群里刷屏）；
    // /指令仍留在私聊。
    const isGroupChat = message.chat?.type === 'group' || message.chat?.type === 'supergroup';
    let groupText = null;
    if (isGroupChat) {
      if (state.ownerUserId !== userId) return; // 陌生人：静默
      const raw = String(message.text ?? message.caption ?? '').trim();
      const mention = `@${tgBotUsername ?? ''}`;
      if (!tgBotUsername || !raw.includes(mention)) return; // 没点名 → 不接
      groupText = raw.split(mention).join('').trim();
      if (groupText.startsWith('/')) return; // 指令不进群，回私聊用
    }

    const decision = authorize(userId);
    if (!decision.ok) {
      const why =
        decision.reason === 'not-owner'
          ? `这个 bot 已经绑定了别的用户。你的 Telegram 用户 ID 是 ${userId}。`
          : `你没有权限使用这个 bot。你的 Telegram 用户 ID 是 ${userId}。`;
      await telegram.sendMessage(chatId, why);
      return;
    }

    const rawText = isGroupChat ? groupText : (message.text ?? message.caption ?? '').trim();

    if (rawText.startsWith('/')) {
      const parts = rawText.split(/\s+/);
      const handled = await handleCommand(
        (t) => telegram.sendMessage(chatId, t),
        chatId,
        userId,
        `tg:${chatId}`,
        parts[0].toLowerCase().split('@')[0],
        parts.slice(1).join(' '),
        'tg',
      );
      if (handled) return;
    }

    /** 组装成 DSH 能收的内容块。 */
    const blocks = [];
    if (rawText) blocks.push({ type: 'text', text: rawText });

    // ---- 图片 ----
    // SDK 约定（@deepseek-ai/dsh-sdk-jsonrpc-server 的 encodedImage 判据）：
    //   { type: 'image', data: <canonical base64>, mediaType: 'image/png' }
    // 图片块必须真的压进 blocks：只声明 inputModalities 是没用的。
    //
    // ⚠️ 字段名是 `mediaType`，**不是** `mimeType` —— 宿主 admitPromptContent
    //    → admitEncodedImages → saveInput 只读 `image.mediaType`
    //    （dsh-attachment/lib/index.js:82）。写成 mimeType 等于传 undefined，
    //    宿主报 `Image type undefined is not accepted by this deployment.`
    //    （2026-09-29 真机日志 20:09:16）。
    const photo = message.photo?.[message.photo.length - 1];
    const imageDocument =
      message.document && String(message.document.mime_type ?? '').startsWith('image/')
        ? message.document
        : null;
    const imageFileId = photo?.file_id ?? imageDocument?.file_id ?? null;
    if (imageFileId) {
      try {
        const bytes = await telegram.getFileBytes(imageFileId);
        blocks.push({
          type: 'image',
          data: bytes.toString('base64'),
          mediaType: imageDocument?.mime_type ?? 'image/jpeg',
        });
      } catch (err) {
        error(`图片下载失败: ${err.message}`);
        await telegram.sendMessage(chatId, `❌ 图片下载失败：${err.message}`);
        return;
      }
    }

    // ---- 语音 ----
    // 下载 → 转写 → 当普通文字送下去。
    // ⚠️ 转写失败的报错必须回给用户：「语音没反应」和「bot 挂了」在用户眼里一模一样。
    if (message.voice || message.audio) {
      const voice = message.voice ?? message.audio;
      let text = '';
      try {
        const bytes = await telegram.getFileBytes(voice.file_id);
        const wav = join(tmpdir(), `botplugin-${randomUUID()}.ogg`);
        await writeFile(wav, bytes);
        text = String(await transcribe(wav)).trim();
        await unlink(wav).catch(() => {});
      } catch (err) {
        error(`语音转写失败: ${err.message}`);
        // 本机没装本地语音引擎（阿里 FunASR）→ 把安装命令原样回给用户，不是让人去改配置。
        await telegram.sendMessage(
          chatId,
          err?.code === 'VOICE_ENGINE_MISSING' ? err.message : `❌ 语音转文字失败：${err.message}`,
        );
        return;
      }
      if (!text) {
        await telegram.sendMessage(chatId, '⚠️ 这段语音没听出内容，麻烦重发或直接打字。');
        return;
      }
      blocks.push({ type: 'text', text });
      // 语音回显（2026-10-06 用户定）：把听到的文字原样发回，让你核对转写对不对。
      // 纯 sendMessage（不走富文本）：转写内容是原话，可能含 markdown/HTML 特殊字符。
      await telegram
        .sendMessage(chatId, `🎤 ${text}`)
        .catch((err) => error(`语音回显发送失败: ${err.message}`));
    }

    if (blocks.length === 0) {
      await telegram.sendMessage(chatId, '我目前只能处理文字和图片。文件等内容还不支持。');
      return;
    }

    if (decision.claimed) {
      await telegram.sendMessage(
        chatId,
        `🔐 你已成为这个 bot 的主人（用户 ID ${userId}），以后只有你能用它。`,
      );
    }

    // 端点 → 节点 → ① DSH ② 其他所有端点
    await hub.inbound(makeMessage({
      source: 'tg',
      chatId,
      text: blocks.map((b) => b.text ?? '[图片]').join(' '),
      raw: { blocks },
    }));
  }

  /**
   * Telegram 按钮回调（/model 的选模型按钮）。
   */
  async function handleCallbackQuery(query) {
    const userId = query.from?.id;
    const data = String(query.data ?? '');
    // 审核卡身份门（任务 #15，2026-10-07）：卡片发在协作群，群里谁都可能按 → 只认老板。
    // 老板 id 与发卡同一个来源（state.ownerUserId，⛔ 不新增第二处判定）；非老板点击一律
    // 静默忽略（连按钮应答都不发 = 零动作）。必须放在 authorize 之前：authorize 对未认领
    // 实例会把第一个点击者认领成主人，群里不能让陌生人抢锚点。
    if (data.startsWith('review:approve:') || data.startsWith('review:reject:')) {
      if (state.ownerUserId === null || userId !== state.ownerUserId) return;
    }
    // Telegram 要求每次按钮按下都必须应答，哪怕后续动作失败。
    await telegram.answerCallbackQuery(query.id).catch(() => {});
    if (!authorize(userId).ok) return;
    // 审批按钮（appr:ok:/appr:no:）优先于模型菜单处理。
    if (approvalBridge?.handleApprovalCallback(data, query)) return;
    // 审核卡（任务 #15 建、#20 改）：✅ → 群发「通过 #N」（主 bot 接力发版）；❌ → edit
    //   卡片提示 + 另发一条 ForceReply 原因条（#20：老板 tap 引用即弹键盘直输原因，不用
    //   手打格式），老板回复原因条 → 拼成「打回 #N：原因」群发（格式一字不改，主 bot 闭环
    //   依赖）。回调有身份门：只认老板（ownerUserId，见 handleCallbackQuery）。
    if (data.startsWith('review:approve:') || data.startsWith('review:reject:')) {
      const no = data.split(':')[2];
      const cardChat = query.message?.chat?.id;
      const cardMsgId = query.message?.message_id;
      const groupId = groupChatIdFromTable() ?? REVIEW_GROUP_FALLBACK;
      if (data.startsWith('review:approve:')) {
        // ① 群发「通过 #N」：纯给人看的公告。TG 平台不向 bot 投递别的 bot 的发言
        //   （官方 Bots FAQ；下方任务表块头注释同款结论）—— 主 bot 天生收不到这条，
        //   #15 把它当「主 bot 监听闭环」的输入，设计时踩了平台规则的坑（#25 实锤）。
        //   第 16 条：成功唯一判据 = 返回带 message_id；没有或发送失败都显式报错，⛔ 不装成功。
        //   ⚠️ #38：宿主 telegram.sendMessage 返回的是【已解包】的消息对象（顶层就有
        //   message_id，bot.js:643-644 直接 sent.message_id 消费可证）——按裸 Bot API
        //   形状 res?.result?.message_id 取会永远 undefined（#37 行「无回执」实锤）。
        //   取法兼容双形状：顶层优先，result 兜底（防中间层形状再变）。
        let approveMsgId = null;
        try {
          const res = await telegram.sendMessage(groupId, `通过 #${no}`);
          approveMsgId = res?.message_id ?? res?.result?.message_id ?? null;
          if (approveMsgId) log(`[审核] #${no} 群发「通过 #${no}」成功（message_id=${approveMsgId}）`);
          else error(`[审核] #${no} 群发「通过 #${no}」返回里没有 message_id —— 按第 16 条不算成功，消息可能被丢弃`);
        } catch (err) {
          error(`[审核] #${no} 群发「通过 #${no}」失败: ${err?.message ?? err}`);
        }
        // ② 任务表通过标记（任务 #25 可靠腿）：主 bot 轮询到它 → 置「发布中」→ 走发版回合。
        //   派活/交活早就是这条路（见任务表块头注释），审批接力补上同一条腿。
        const recorded = recordBossApproval(no, approveMsgId);
        await editReviewCard(
          cardChat,
          cardMsgId,
          [
            approveMsgId
              ? `✅ #${no} 已通过 —— 「通过 #${no}」已发协作群（message_id=${approveMsgId}）。`
              : `✅ #${no} 已通过 —— ⚠️ 群发「通过 #${no}」没拿到送达回执（发送失败或 message_id 缺失），群里可能看不到那条。`,
            recorded
              ? '已写任务表通过标记，等主 bot 发版。'
              : '⚠️ 任务表通过标记没写成（表不在/行不是「待审核」）—— 主 bot 没动静时，请在群里直接发「通过 #N」。',
          ].join('\n'),
        );
        log(`[审核] #${no} 老板点通过 → 群发${approveMsgId ? `（message_id=${approveMsgId}）` : '（⚠️ 无送达回执）'}；任务表标记${recorded ? '已写' : '未写成'}`);
      } else {
        await editReviewCard(cardChat, cardMsgId, `❌ #${no} 已选打回 —— 请直接在群里发「打回 #${no}：原因」（主 bot 监听这个格式回流小工）。`);
        await sendRejectPrompt(no, groupId, cardChat, cardMsgId);
        log(`[审核] #${no} 老板点打回 → 卡片已提示 + 打回原因条（ForceReply）已发`);
      }
      return;
    }
    if (data.startsWith('model:')) {
      await handleCommand(
        (t) => telegram.sendMessage(query.message.chat.id, t),
        query.message.chat.id,
        userId,
        `tg:${query.message.chat.id}`,
        '/model',
        data.slice(6),
        'tg',
      );
    }
  }

  /**
   * 斜杠命令。
   *
   * 已实现的是插件自己就能完成的那几个；/restart 这类需要重启宿主进程的
   *    命令语义不同，留待后续。
   *
   * @returns {Promise<boolean>} true = 已处理（调用方不要再当普通消息发）
   */
  /**
   * 组装重启接力脚本的环境变量；无法安全拉起时返回 null（/restart 退化为只重开会话）。
   *
   * 两条拉起路径：
   *   ① 启动器（macOS 安装包用户）：配置 restartCommand，或工作目录里的
   *      `start.command`（setupbot 现在生成的就是这个名字；
   *      兼容老的 `启动-<工作区名>.command` / `启动-mybot.command` / `启动.command`），
   *      helper 用 `open` 重开一个新的终端窗口；
   *   ② 原始命令行：把本进程的 node + 脚本 + 参数原样交给 helper nohup 拉起（尽力而为，
   *      宿主原先是终端窗口的话，那个窗口会结束、bot 转后台）。
   */
  // 找启动器：跨平台兼容。
  // macOS：setupbot 生成 start.command（双击弹终端窗口），也兼容老的 启动-* 前缀。
  // Linux：setupbot 生成 start.sh（nohup 后台拉起），也兼容 -start.sh 后缀。
  function findLauncher(cwd) {
    // macOS .command 文件
    const macLegacy = ['start.command', '启动-mybot.command', '启动.command']
      .map((n) => join(cwd, n))
      .find((p) => existsSync(p));
    if (macLegacy) return macLegacy;
    try {
      const macHit = readdirSync(cwd)
        .filter((n) => n.startsWith('启动-') && n.endsWith('.command'))
        .sort()[0];
      if (macHit) return join(cwd, macHit);
    } catch { /* 目录读不了 */ }

    // Linux .sh 文件
    const linuxLauncher = ['start.sh'].map((n) => join(cwd, n)).find((p) => existsSync(p));
    if (linuxLauncher) return linuxLauncher;
    try {
      const linuxHit = readdirSync(cwd)
        .filter((n) => n === 'start.sh' || n.endsWith('-start.sh'))
        .sort()[0];
      if (linuxHit) return join(cwd, linuxHit);
    } catch { /* 目录读不了 */ }

    // fallback：优先返回 .command（macOS 用户），没有则返回 null（Linux 走 nohup 路径）
    const fallback = join(cwd, 'start.command');
    return existsSync(fallback) ? fallback : null;
  }

  function restartPlanEnv() {
    const cwd = config.cwd || process.cwd();
    const launcher = config.restartCommand || findLauncher(cwd);
    const hasLauncher = Boolean(launcher) && existsSync(launcher);
    const [, scriptPath, ...extraArgs] = process.argv;
    // systemd 注入 INVOCATION_ID；systemd 的 cgroup 管理能可靠地重启进程，
    // 所以 systemd 托管时可以安全走 RESTART_SUPERVISED（只杀宿主、不自己拉）。
    //
    // launchd（任务 #4，2026-10-07）：旧的「launchd 例外 → helper 自己 nohup 拉起」
    // 废除 —— 那会造出**不受监管的孤儿实例**：它持有单实例锁，kickstart -k 杀不到，
    // 只能人工 TERM（实例 93512 事故）。现在把 label 传给 helper，由它
    // `launchctl kickstart -k` 杀旧 + 由 launchd 拉受监管的新实例 → 锁持有者=被监管进程。
    // kickstart 不依赖宿主退出码（dsh 宿主吃 TERM 是 exit 0，SuccessfulExit=false 的
    // KeepAlive 不会拉 —— kickstart -k 直接杀+拉，绕开这个坑）。
    const launchdLabel = /^[\w.+-]+\.[\w.+-]+$/.test(String(process.env.XPC_SERVICE_NAME ?? '').trim())
      ? String(process.env.XPC_SERVICE_NAME).trim()
      : null;
    const supervisor = process.env.INVOCATION_ID ? 'systemd' : launchdLabel ? 'launchd' : null;
    if (!hasLauncher && !scriptPath && !supervisor) return null;
    return {
      RESTART_DELAY_SECONDS: '8',
      RESTART_TARGET_PID: String(process.pid),
      RESTART_LOG: join(cwd, 'dsh-restart.log'),
      // 被托管：launchd → kickstart -k（杀旧+受监管拉新）；systemd → 只杀，cgroup 拉新。
      // ⛔ 两条路都不再 nohup 另起脱离进程。
      ...(supervisor
        ? {
            RESTART_SUPERVISED: supervisor,
            ...(launchdLabel ? { RESTART_LAUNCHD_LABEL: launchdLabel } : {}),
          }
        : hasLauncher
          ? { RESTART_LAUNCHER: launcher }
          : {
              RESTART_NODE: process.execPath,
              RESTART_SCRIPT: scriptPath,
              RESTART_ARGS: extraArgs.join(' '),
              RESTART_CWD: cwd,
            }),
      ...(config.telegramToken ? { RESTART_TG_TOKEN: config.telegramToken } : {}),
    };
  }

  async function handleCommand(reply, chatId, userId, chatKey, command, arg = '', source = 'tg') {
    switch (command) {
      case '/whoami':
        await reply(
          source === 'wx'
            ? `你的微信用户 ID: ${userId}\n本聊天 ID: wx-${userId}`
            : `你的用户 ID: ${userId}\n本聊天 ID: ${chatId}`,
        );
        return true;

      case '/status': {
        // 老 bot 同款字段：会话 ID / 已存在 / 工作目录 / 模型（含思考强度）/ 权限模式 / 进程状态。
        const sid = runtime.sessionIdOf(chatKey);
        const createdAt = sessionCreatedAt.get(chatKey) ?? 0;
        const ageMinutes = createdAt ? Math.round((Date.now() - createdAt) / 60000) : null;
        const current = useHostRoutes ? await refreshHostRoute() : activeRoute;
        const effort = current ? reasoningEffortFor(current, undefined) : undefined;
        const effortText = effort === 'off' ? ' (思考已关闭)' : effort ? ` (思考强度 ${effort})` : '';
        const lines = [
          '📊 当前状态',
          `会话 ID: ${sid ?? '(未建立)'}`,
          ageMinutes !== null ? `已存在: ${ageMinutes} 分钟` : '已存在: (未知)',
          `工作目录: ${config.cwd || process.cwd()}`,
          `模型: ${current ? `${current.key} — ${current.provider} / ${current.model}` : '(未配置)'}${current ? effortText : ''}`,
          '权限模式: 由 profile 的 cordis.patch.yml 里 permission.defaultPreset 决定（bot 不覆盖）',
          `DSH 进程: ${runtime.ready ? '运行中 ✅' : '未运行 ⚠️'}`,
        ];
        await reply(lines.join('\n'));
        return true;
      }

      case '/model': {
        // 宿主模式下实时重建表单：web 端刚加的模型立刻能看到。
        const table = useHostRoutes ? await hostModelTable() : { list: routeList };
        const current = useHostRoutes ? await refreshHostRoute() : activeRoute;
        const picks = table.list;
        if (!arg) {
          if (source === 'tg') {
            // 老 bot 同款：菜单文 + 内联按钮（当前档 ✅ 后缀，点按钮直接切）。
            const menu = [
              '🧠 选择模型',
              '',
              `当前：${current ? describeRoute(current) : '(未配置)'}`,
              '',
              '点下面的按钮切换。',
            ].join('\n');
            await telegram.sendMessage(chatId, menu, {
              reply_markup: {
                inline_keyboard: picks.map((r) => [
                  {
                    // ✅ 放**后缀**不放前缀 —— 前缀会把那一行文字整体右推（老 bot 2026-09-19 的结论）。
                    text: `${r.short}${current && r.key === current.key ? ' ✅' : ''}`,
                    callback_data: `model:${r.key}`,
                  },
                ]),
              },
            });
          } else {
            // 老 bot 微信同款：编号清单，回 /model <编号> 直接切。
            const lines = [
              '🧠 选择模型',
              '',
              `当前: ${current ? describeRoute(current) : '(未配置)'}`,
              '',
              '可用模型:',
              ...picks.map(
                (r, i) =>
                  `${i + 1}. ${current && r.key === current.key ? '✅ ' : ''}${r.key} (${r.provider} / ${r.model})`,
              ),
              '',
              '回复 /model <编号> 直接切换，例如 /model 2',
              `（也认 key，例如 /model ${(picks.find((r) => !current || r.key !== current.key) ?? picks[0])?.key ?? ''}）`,
            ].join('\n');
            await reply(lines);
          }
          return true;
        }
        // 带参数：纯数字按编号，否则按 key/label 模糊匹配（老 bot 微信同款）。
        let wanted = null;
        if (/^\d+$/.test(arg.trim())) {
          const idx = Number(arg.trim()) - 1;
          if (idx >= 0 && idx < picks.length) wanted = picks[idx];
        } else {
          const low = arg.trim().toLowerCase();
          wanted =
            picks.find((r) => r.key.toLowerCase() === low) ??
            picks.find((r) => (r.label ?? '').toLowerCase() === low) ??
            picks.find((r) => r.key.toLowerCase().startsWith(low)) ??
            null;
        }
        if (!wanted) {
          if (source === 'wx') {
            await reply(
              `❓ 不认识「${arg.trim()}」。\n` +
                '可用编号:' +
                picks.map((r, i) => `\n${i + 1}. ${r.label}`).join('') +
                '\n\n发 /model 看完整清单。',
            );
          } else {
            await reply(`没有这条路由：${arg.trim()}`);
          }
          return true;
        }
        if (current && wanted.key === current.key && runtime.ready) {
          await reply(
            source === 'tg' ? `当前已经是「${wanted.short}」了。` : `当前已经是「${wanted.label}」了。`,
          );
          return true;
        }
        await reply(`⏳ 正在切换到「${wanted.label}」…`);
        // 切模型 = 重建句柄并 resume 同一会话（历史保留、新模型接着聊），handoff 照写作记忆兜底：
        // 本次会话 ≥20 条才写，调试期间反复切模型不会覆盖已有记忆。
        if (memory) {
          memory.maybeWriteHandoff({
            sessionId: runtime.sessionIdOf(chatKey) ?? chatKey,
            reason: 'model',
            currentRoute: () => current,
            ownerUserId: state.ownerUserId,
            workspace: config.cwd || process.cwd(),
            sessionCreatedAt: sessionCreatedAt.get(chatKey) ?? 0,
          });
        }
        const switched = await runtime.switchRoute(chatKey, wanted);
        if (switched.ok) {
          // 两档来源都要记住：手写 routes 直接换 activeRoute；跟随宿主时写记忆位，
          // 下一次 refreshHostRoute() 才不会把显示覆盖回 web 默认档。
          activeRoute = wanted;
          if (useHostRoutes) rememberPickedKey(wanted.key);
          await reply(
            `✅ 已切换到「${wanted.label}」\n${wanted.provider} / ${wanted.model}\n\n当前会话历史已带过去，直接接着聊即可。`,
          );
        } else {
          await reply(`❌ 切换到「${wanted.label}」失败:${switched.error}`);
        }
        return true;
      }

      case '/new': {
        // 断开前写 handoff —— 这正是「handoff」这个功能的第二半。
        if (memory) {
          memory.maybeWriteHandoff({
            sessionId: runtime.sessionIdOf(chatKey) ?? chatKey,
            reason: 'new',
            currentRoute: () => activeRoute,
            ownerUserId: state.ownerUserId,
            workspace: config.cwd || process.cwd(),
            sessionCreatedAt: sessionCreatedAt.get(chatKey) ?? 0,
          });
        }
        // ⚠️ 必须用 resetSession（连会话 id 一起换），⛔ 不是 closeSession（只关句柄）——
        //    老 id 还在的话，下一条消息会按它 resume 回同一份历史，「新会话」是假的。
        await runtime.resetSession(chatKey);
        sessionCreatedAt.set(chatKey, Date.now());
        await telegram.sendMessage(chatId, '🆕 已开新会话（上一段进展已存进 handoff）。');
        return true;
      }

      case '/restart': {
        // 与老 bot 同口径：重启前**无条件**写 handoff —— 用户明确要留档，
        // 不设 20 条门槛（刚聊两句也要重启时，恰恰最需要把这两句留下）。
        if (memory) {
          memory.writeHandoff({
            sessionId: runtime.sessionIdOf(chatKey) ?? chatKey,
            reason: 'restart',
            currentRoute: () => activeRoute,
            ownerUserId: state.ownerUserId,
            workspace: config.cwd || process.cwd(),
          });
        }
        // 重启前先把会话 id 换掉（与 /new、老 bot 同口径）：重启后第一条消息
        // 开的是全新会话，靠冷启动记忆衔接，而不是 resume 回旧历史。
        await runtime.resetSession(chatKey);
        // 真·重启：动作交给**进程外**的接力脚本（spawn detached → setsid 独立进程组），
        // 由它延迟几秒后杀宿主进程树、再拉起新宿主 —— 与老 bot 的 restart-helper.sh 同路。
        // 插件自己绝不能动手：自杀 = 当前回合被 dispose，连确认消息都发不出去。
        const helper = join(dirname(fileURLToPath(import.meta.url)), '..', 'restart-helper.sh');
        const planEnv = restartPlanEnv();
        if (existsSync(helper) && planEnv) {
          const bashPath = (() => { try { return execFileSync('which', ['bash'], { timeout: 3000 }).toString().trim(); } catch { return '/bin/sh'; } })();
          const child = spawn(bashPath, [helper], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, ...planEnv },
          });
          child.unref();
          await telegram.sendMessage(
            chatId,
            [
              '♻️ 已收到重启指令（上一段进展已留档）。',
              `约 ${planEnv.RESTART_DELAY_SECONDS} 秒后重启进程，以加载新代码。`,
              '',
              '重启完成后请发任意一条消息唤醒 —— 新会话会自动带上刚才的记忆。',
            ].join('\n'),
          );
          return true;
        }
        // 拉不起新进程（没有 helper/启动器/命令行）→ 退回「只重开会话」，
        // 绝不能让 bot 凭空消失。
        await runtime.resetSession(chatKey);
        sessionCreatedAt.set(chatKey, Date.now());
        await telegram.sendMessage(
          chatId,
          '🔄 已重开会话，上一段进展已留档（下一条消息自动带回）。\n'
          + '⚠️ 没找到重启接力脚本/启动器，进程没法自动拉起 —— 加载新代码请手动重启。',
        );
        return true;
      }

      case '/setupdsh': {
        // 升级 DSH + bot（调用 setupdsh.sh）
        const helper = join(dirname(fileURLToPath(import.meta.url)), '..', 'setupdsh-helper.sh');
        if (existsSync(helper)) {
          // ⚠️ 先 spawn 再回执：回执曾经写死走 telegram.sendMessage(chatId)，
          //    微信入站时 chatId 是微信用户 id → 必报 chat not found，
          //    异常又发生在 spawn 之前 → 升级脚本根本没被拉起（2026-10-02 实测）。
          //    现在回执走 reply（微信走微信、TG 走 TG），且失败只当没回执，不挡升级。
          const child = spawn('bash', [helper], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env },
          });
          child.on('error', (err) => error(`setupdsh 升级脚本拉起失败: ${err.message}`));
          child.unref();
          await reply('⬆️ 正在启动 SetupDSH&BOT 升级…').catch(() => {});
          return true;
        }
        await reply('⚠️ 未找到 setupdsh-helper.sh，无法执行升级。').catch(() => {});
        return true;
      }

      case '/start':
      case '/help': {
        // 老 bot 同款文案（/model 一行列出所有模型 label）。
        const labels = (useHostRoutes ? (await hostModelTable()).list : routeList)
          .map((r) => r.label ?? r.key)
          .join(' / ');
        await reply(
          [
            '👋 我是接在 DeepSeek Harness 上的助手,直接发消息就能用。',
            '',
            '可用命令:',
            '/new — 开启一个全新会话(清空上下文)',
            `/model — 切换模型(${labels})`,
            '/restart — 重启 bot 加载新代码（会断开当前会话）',
            '/setupdsh — SetupDSH&BOT（升级 DSH + bot 插件）',
            '/status — 查看当前会话和运行状态',
            source === 'wx' ? '/whoami — 查看你的用户 ID' : '/whoami — 查看你的 Telegram 用户 ID',
            '/help — 显示这份帮助',
            '',
            '也可以直接发图片、语音给我。',
          ].join('\n'),
        );
        return true;
      }

      default:
        return false; // 不认识的命令 → 当普通消息交给模型
    }
  }

  // -------------------------------------------------------------------------
  // 微信长轮询
  // -------------------------------------------------------------------------
  let wxCursor = '';
  let wxAbort = null;
  /** 未登录时的 ret=-2 只提示一次，避免每 30 秒刷一条日志。 */
  let wxRetMinus2Noted = false;

  async function weixinPollLoop() {
    if (!weixinReady) {
      log('微信入口未启用（没配 token 也没找到凭据文件）');
      return;
    }
    log(`微信轮询启动 — bot ${weixin.botId || '(待确认)'} 主人 ${weixin.ownerWxUserId || '(待确认)'}`);
    weixin.notifyStart().catch(() => {});

    while (!state.stopped) {
      let batch;
      try {
        batch = await weixin.getUpdates(wxCursor, 30_000, wxAbort?.signal);
      } catch (err) {
        if (state.stopped) break;
        if (!/abort/i.test(err.message ?? '')) error(`微信 getUpdates 失败: ${err.message}`);
        await sleep(3000);
        continue;
      }

      // 即使 ret≠0 也要推进游标，否则后续调用一直用空 cursor 重试。
      if (batch.get_updates_buf) wxCursor = batch.get_updates_buf;
      // ret=-2 = 通道「伪过期」，清掉本地缓存等用户下一条消息带新 token 恢复。
      //
      // ⚠️ 分级上报：**没登录过**（从没拿到过主人的 context_token）时这是常态，
      //    每 30 秒报一条 `error` 只会淹掉真问题 —— 用户看到满屏红字以为坏了。
      //    此时降级成 `log` 并只报一次；真的登录过又掉线才是 error（那要修）。
      if (batch.ret === -2) {
        const everConnected = wxContextTokens.size > 0 || Boolean(weixin.ownerWxUserId);
        if (everConnected) {
          error('微信通道 ret=-2（伪过期），清除本地缓存，等用户下一条消息恢复');
          await weixin.reconnect().catch(() => {});
        } else if (!wxRetMinus2Noted) {
          wxRetMinus2Noted = true;
          log('微信未登录（ret=-2），跳过轮询恢复；登录后自动转为正常');
        }
        continue;
      }

      for (const msg of batch.msgs ?? []) {
        handleWeixinMessage(msg).catch((err) =>
          error(`微信消息处理出错: ${err?.stack ?? err?.message}`),
        );
      }
    }
  }

  async function handleWeixinMessage(message) {
    if (message?.message_type !== 1) return; // 只要用户发来的
    const fromUserId = String(message.from_user_id ?? message.from_user ?? '');
    if (!fromUserId) return;

    // 新鲜 context_token 必存 —— 通道恢复靠它。
    if (message.context_token) wxContextTokens.set(fromUserId, message.context_token);

    // 白名单：配了就只认那一个
    const allowWx = config.weixinAllowedUserId?.trim();
    if (allowWx && fromUserId !== allowWx) return;

    const text = extractWxText(message);
    if (!text) return;

    await hub.inbound(makeMessage({ source: 'wx', chatId: fromUserId, text, raw: message }));
  }

  /** 取微信消息的正文：优先文字 item，其次服务端已转好的语音文字。 */
  function extractWxText(message) {
    const items = message?.item_list ?? [];
    const textItem = items.find((it) => it?.type === 1 && it?.text_item?.text);
    if (textItem) return textItem.text_item.text;
    // 微信 iLink 服务端已经做了语音转文字，结果在 voice_item.text
    const voiceItem = items.find((it) => it?.type === 3);
    return voiceItem?.voice_item?.text ?? null;
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  if (!telegram && !weixinReady) {
    error('⚠️ Telegram 和微信都没配，插件不会收任何消息（只保留了 handoff 能力）。');
  }

  if (telegram) {
    telegram
      .setMyCommands([
        { command: 'new', description: '开启新会话' },
        { command: 'model', description: '切换模型' },
        { command: 'restart', description: '重启 bot 加载新代码' },
        { command: 'setupdsh', description: '升级 DSH&BOT' },
        { command: 'status', description: '查看当前状态' },
        { command: 'whoami', description: '查看我的用户 ID' },
        { command: 'help', description: '显示帮助' },
      ])
      .catch((err) => error(`setMyCommands 失败: ${err.message}`));

    telegram
      .getMe()
      .then((info) => {
        tgBotUsername = info.username ?? null;
        log(`Telegram 已登录：@${info.username} (${info.id})`);
      })
      .catch((err) => error(`连不上 Telegram：${err.message}`));

    // ---- 识图能力自动探测（与老 bot 的 bot.sh 启动钩子同款）----
    // 后台跑一次 vision-auto：假设所有模型都识图（defaultInput），真发一张测试图逐个验证，
    // 不支持的自动标记 input: [text]。⚠️ 刻意**不阻断启动**：无网/超时/脚本挂了只警告，
    // 探测脚本自己保证「只加不删 + 自动备份 + 幂等」。走 detached 子进程，不占插件生命周期。
    if (config.visionAutoDetect) {
      try {
        const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'vision-auto.mjs');
        if (existsSync(script)) {
          // 输出落 <cwd>/vision-auto.log —— 静默失败最坑（2026-09-29 评审 #2）：必须留痕。
          // 不带 --quiet：探测的每一行结论都进日志，出事能查。
          const logPath = join(config.cwd || process.cwd(), 'vision-auto.log');
          let fd = null;
          try {
            appendFileSync(logPath, `\n──── ${new Date().toISOString()} 探测开始 ────\n`);
            fd = openSync(logPath, 'a');
          } catch {}
          const child = spawn(process.execPath, [script], {
            detached: true,
            stdio: fd === null ? 'ignore' : ['ignore', fd, fd],
          });
          child.unref();
          // unref 只是不让子进程拖住宿主退出，exit 事件照发 —— 退出码必须上报，
          // 否则「已启动」和「成功」分不清。
          child.on('exit', (code, signal) => {
            if (code === 0) log('识图探测完成');
            else error(`识图探测失败（${signal ? `信号 ${signal}` : `退出码 ${code}`}），详见 ${logPath}`);
          });
          log('识图自动探测已在后台启动（输出: vision-auto.log）');
        } else {
          log('未找到 vendor/vision-auto.mjs，跳过识图探测');
        }
      } catch (err) {
        error(`识图探测启动失败（不影响运行）: ${err?.message}`);
      }
    }
  }

  /**
   * 启动补写 handoff —— 断电/崩溃/launchd 拉起这类「来不及在断开前写」的场合。
   * ⚠️ 这类补写的时间戳是**启动时刻**，晚于真实断开时刻，属正常。
   */
  if (memory) {
    memory.catchUpHandoffOnBoot({
      sessionId: 'botplugin',
      reason: 'boot',
      currentRoute: () => activeRoute,
      ownerUserId: state.ownerUserId,
      workspace: config.cwd || process.cwd(),
    });
  }

  pollAbort = new AbortController();
  wxAbort = new AbortController();

  // ---- 第 1 层：单实例锁（开始轮询之前决出唯一）----
  // 只在配了 Telegram 时才需要：409 只属于 getUpdates，微信通道不会因为多一份实例
  // 而打架 —— 不配 TG 的实例不该去占这把锁，否则会把同目录下真正要收 TG 的实例挡住。
  const lock = telegram
    ? createInstanceLock({
        lockPath: join(config.cwd || process.cwd(), '.botplugin.lock'),
        log,
        error,
      })
    : null;

  /**
   * 等锁 → 轮询（Telegram 专用）。
   *
   * 拿不到锁（另一个活着的实例正在用同一个 token）时**不退出进程**，而是每 60 秒
   * 重试获取：那份实例一旦死掉，本实例就自动接上，全程不会 409。
   * 微信不受 409 影响，所以不参与这把锁，照原样立刻开始轮询。
   */
  async function telegramPollWhenLocked() {
    if (!telegram || !lock) return;
    let waits = 0;
    // 外层循环 = 「排队等锁 → 拿到就轮询 → 若被判半瘫、锁被接管，就回队伍里重排」。
    // 有这一层，被接管的实例不会永久哑掉：接管的那个一旦退出/也半瘫，本实例能再接上。
    while (!state.stopped) {
      if (await lock.acquire()) {
        waits = 0;
        // pollLoop 只在两种情况下返回：插件被卸载（state.stopped），
        // 或本实例被判半瘫、锁已被别的实例接管 → 回到外层重新排队。
        await pollLoop();
        continue;
      }
      waits += 1;
      // 大声说一次就够，重试本身每 60 秒都会在 acquire 里留下可读的日志。
      if (waits === 1) {
        error('');
        error('❌ 单实例锁被另一个活着的进程持有 —— 本实例暂不轮询（不会退出进程）。');
        error('   常见原因：同一个 token 有两份实例在跑（比如重复双击了启动器）。');
        error(`   每 ${LOCK_RETRY_MS / 1000} 秒重试一次；对方退出、或心跳停 ${LOCK_STALE_MS / 1000} 秒被判半瘫后，本实例自动接上。`);
      }
      // 通知同样节流：第 1 次 + 之后每 10 次一次（≈10 分钟），别刷屏。
      if (waits === 1 || waits % 10 === 0) await notifyOwner(LOCK_BUSY_NOTICE);
      await sleepAbortable(LOCK_RETRY_MS, pollAbort?.signal);
    }
    // 卸载（含等锁期间被卸载）：锁若还在自己手上就还回去，别给下一个进程留僵尸锁。
    await lock.release();
  }

  // 两个轮询并行跑；单个挂掉不影响另一个（微信没登录也必须让 TG 照跑）。
  Promise.all([telegramPollWhenLocked(), weixinPollLoop()]).catch((err) =>
    error(`轮询循环异常退出: ${err?.stack ?? err?.message}`),
  );

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // 协作任务表轮询（插件版 = 干活：认领「待领取」→ 自动开一轮活）
  //
  // 账本 = 任务表.md，与主 bot 共享同一份文件；Telegram 平台不向 bot 投递
  // 别的 bot 的群消息，所以派活/交活只走文件，群只做「给人看」的播报。
  // 状态流转：待领取 →(本插件领)→ 进行中 →(干完)→ 待验收 →(主 bot 验)→ 已发布/打回。
  // ⚠️ 触发前先把状态改成「进行中」占位：状态被改掉，轮询就不会重复触发同一行。
  // ⚠️ 写入走 tmp+rename 原子替换（两个进程共写一份文件）。
  // -------------------------------------------------------------------------
  const TASK_TABLE_PATH = process.env.DSH_TASK_TABLE ?? '/Users/tcm/DSH/BOT/任务表.md';
  const TASK_POLL_MS = 5000;
  let taskTimer = null;

  function readTaskTable() {
    try {
      return readFileSync(TASK_TABLE_PATH, 'utf8');
    } catch {
      return null;
    }
  }

  function writeTaskTable(text) {
    const tmp = `${TASK_TABLE_PATH}.tmp.${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, TASK_TABLE_PATH);
  }

  /** 任务表头「协作群 chat id」：主 bot 在群里收到消息时回填，自动派活取它发群。 */
  function groupChatIdFromTable() {
    const raw = readTaskTable()?.match(/^> 协作群 chat id:\s*(\S+)/m)?.[1] ?? null;
    return raw && /^-?\d+$/.test(raw) ? raw : null; // 只认数字，表头占位文字不算
  }

  /** 找第一个「负责=插件版 且 状态=期望值」的表格行 → { index, line, no, task } 或 null。 */
  function findTaskRow(table, statusWanted) {
    const lines = table.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\|\s*(\d+)\s*\|([^|]+)\|\s*插件版\s*\|\s*([^|]+?)\s*\|/);
      if (m && m[3] === statusWanted) return { index: i, line: lines[i], no: m[1], task: m[2].trim() };
    }
    return null;
  }

  /** 把 findTaskRow 找到的行按列改状态（按 | 拆分重建，不受任务文本内容影响）。 */
  function setTaskStatus(row, nextStatus) {
    const table = readTaskTable();
    if (!table) return;
    const lines = table.split('\n');
    if (lines[row.index] !== row.line) return; // 行已被别人动过：放弃本轮，防覆盖
    const cells = lines[row.index].split('|'); // ['', no, task, owner, status, note, '']
    if (cells.length < 6 || cells[3].trim() !== '插件版') return;
    cells[4] = ` ${nextStatus} `;
    lines[row.index] = cells.join('|');
    writeTaskTable(lines.join('\n'));
  }

  function watchTaskTable() {
    taskTimer = setInterval(() => {
      try {
        if (state.stopped) return;
        const table = readTaskTable();
        if (!table) return;
        const row = findTaskRow(table, '待领取');
        if (row) {
          setTaskStatus(row, '进行中'); // 先占位，防下轮重复触发
          const groupId = groupChatIdFromTable();
          const chatId = groupId ? Number(groupId) : state.ownerUserId;
          if (chatId) {
            const prompt = [
              '<自动派活（系统触发，无需回复此段）>',
              `任务表 #${row.no} 派给你。任务：${row.task}`,
              '规矩：只改文件 + 自测，⛔ git 提交/推送/发版由主 bot 验收后做；改完把任务表该行状态改成「待验收」；进度随时发回协作群。',
              '</自动派活>',
            ].join('\n');
            const msg = { source: 'tg', chatId, text: prompt, raw: null };
            void enqueue(`tg:${chatId}`, () => promptFromHub(msg));
            log(`[任务表] #${row.no} 已领活 → chat ${chatId}`);
          }
        }
        // 审核卡（任务 #15）：同一轮询顺带扫「待审核」行 → 协作群卡片（REVIEWER_MODE 才开）
        reviewTick(table);
      } catch (err) {
        error(`[任务表] 轮询失败: ${err?.message ?? err}`);
      }
    }, TASK_POLL_MS);
  }
  // -------------------------------------------------------------------------
  // 审核弹窗（任务 #4 建、任务 #15 改，2026-10-07）：插件版 = 审核实例。任务表出现
  // 「待审核」行 → 协作群发审核卡片（inline_keyboard：✅通过 #N / ❌打回 #N）；
  // 群 id 沿用现有群发逻辑：表头「协作群 chat id」优先，兜底 REVIEW_GROUP_FALLBACK。
  // ✅ 回调 → 以文本「通过 #N」发进协作群 —— 主 bot 监听这个格式走发布闭环；
  // ❌ 回调 → edit 卡片提示 + 另发一条 ForceReply「原因条」（#20：老板 tap 引用即弹键盘
  //   直输原因），老板回复原因条 → 拼成「打回 #N：原因」群发（格式一字不改，主 bot 闭环
  //   依赖）；5 分钟不回复 → 原因条改写成兜底文案，维持「群里发打回 #N：原因」老路；
  //   回复 /cancel → 取消。回调与原因条都有身份门：只认老板（ownerUserId，⛔ 不新增判定）。
  // 本插件只传话，⛔ 不自己改任务表、不碰 git/发布。
  // 节流：每个 #N 自进程启动只发一次卡（行停在「待审核」也不重发；发送失败会在
  //   下一轮重试；进程重启后会重发一次 —— 多一张卡无副作用）。
  // -------------------------------------------------------------------------
  const REVIEW_GROUP_FALLBACK = '-5334440553'; // 协作群兜底（表头有「协作群 chat id」时以表头为准）
  /** 已成功发出卡的 #N（防 5 秒轮询重复发）。 */
  const reviewCardsSent = new Set();

  // -------------------------------------------------------------------------
  // 打回原因 ForceReply（任务 #20，2026-10-07）：点 ❌ 后除卡片提示外，另发一条
  // reply_markup=ForceReply 的「原因条」—— 老板 tap 引用即弹键盘直输原因。
  // 老板回复原因条 → 拼成「打回 #N：原因」群发；回复 /cancel → 取消；5 分钟不回复 →
  // 原因条改写成兜底文案（与卡片提示同款，维持 #15 的群里手打老路）。
  // -------------------------------------------------------------------------
  const REJECT_REPLY_WAIT_MS = 5 * 60 * 1000;
  /** 待回复的原因条：原因条 message_id → { no, groupId, cardChat, cardMsgId, timer }。 */
  const pendingRejects = new Map();

  /** 发「打回原因」原因条（ForceReply）并登记等回复；拿不到 message_id 就只发不登记
   *  （听不到回复 → 老板走卡片提示的群里手打兜底，行为不劣于 #15）。 */
  async function sendRejectPrompt(no, groupId, cardChat, cardMsgId) {
    if (!telegram) return;
    const res = await telegram.sendMessage(
      groupId,
      [
        `❌ 打回 #${no} —— 请回复本条直接输入打回原因，我会转成「打回 #${no}：原因」发进协作群。`,
        `回复 /cancel 取消；${REJECT_REPLY_WAIT_MS / 60000} 分钟内不回复，就直接在群里发「打回 #${no}：原因」。`,
      ].join('\n'),
      { reply_markup: { force_reply: { force_reply: true, input_field_placeholder: '打回原因…' } } },
    );
    // #38：宿主返回【已解包】消息对象（顶层 message_id，见上方审核代发处注释）；
    //   兼容双形状取法，别按裸 Bot API 的 result 形状取（会永远 undefined → 原因条登记不上）。
    const promptMsgId = res?.message_id ?? res?.result?.message_id ?? null;
    if (!promptMsgId) return;
    pendingRejects.set(promptMsgId, {
      no, groupId, cardChat, cardMsgId,
      timer: setTimeout(() => expireRejectPrompt(promptMsgId), REJECT_REPLY_WAIT_MS),
    });
    log(`[审核] #${no} 打回原因条已发（等老板回复，${REJECT_REPLY_WAIT_MS / 60000} 分钟）`);
  }

  /** 老板对原因条的回复（#20）。返回 true = 本条已消费，调用方不要再当普通消息走。
   *  ⚠️ 必须挂在 handleTelegramMessage 群模式过滤之前：群里回复不带 @点名，晚了会被静默丢。 */
  async function handleRejectReasonReply(message) {
    const promptMsgId = message?.reply_to_message?.message_id;
    if (!promptMsgId || !pendingRejects.has(promptMsgId)) return false;
    // 身份门：只有老板的回复算数（老板 id 唯一来源 state.ownerUserId，与卡片回调同源）。
    // 非老板零动作（不消费、不 edit）—— 沉回正常路径由群模式过滤自然处理。
    if (state.ownerUserId === null || message.from?.id !== state.ownerUserId) return false;
    const entry = pendingRejects.get(promptMsgId);
    if (String(message.chat?.id ?? '') !== String(entry.groupId)) return false;
    const raw = String(message.text ?? '').trim();
    if (raw.startsWith('/')) {
      if (/^\/cancel\b/.test(raw)) {
        clearTimeout(entry.timer);
        pendingRejects.delete(promptMsgId);
        await telegram.editMessageText(entry.groupId, promptMsgId, `❌ #${entry.no} 打回原因条已取消 —— 请直接在群里发「打回 #${entry.no}：原因」。`).catch(() => {});
        log(`[审核] #${entry.no} 老板 /cancel → 打回原因条已取消`);
      }
      return false; // 其它指令不当原因，交回正常路径（群模式下没点名自然被忽略）
    }
    if (!raw) return false; // 空文本（贴图/表情等）不当原因
    // 消费：拼「打回 #N：原因」群发 —— 格式一字不改；先撤待回复再发（防重入重发）。
    clearTimeout(entry.timer);
    pendingRejects.delete(promptMsgId);
    await telegram.sendMessage(entry.groupId, `打回 #${entry.no}：${raw}`);
    await telegram.editMessageText(entry.groupId, promptMsgId, `✅ 已代发「打回 #${entry.no}：${raw}」进协作群。`).catch(() => {});
    // 卡面提示必须跟着改口：不 edit 的话卡片还停在「请直接在群里发…」，老板照做就重复打回了。
    await editReviewCard(entry.cardChat, entry.cardMsgId, `❌ #${entry.no} 已打回 —— 「打回 #${entry.no}：${raw}」已发协作群，等主 bot 回流小工。`);
    log(`[审核] #${entry.no} 老板回复原因条 → 已群发「打回 #${entry.no}：…」`);
    return true;
  }

  /** 超时没等到老板回复 → 原因条改写成兜底文案（维持 #15 的「群里发打回 #N：原因」老路）。
   *  幂等：条已回复/已取消/被删时空转返回。 */
  async function expireRejectPrompt(promptMsgId) {
    const entry = pendingRejects.get(promptMsgId);
    if (!entry) return;
    pendingRejects.delete(promptMsgId);
    await telegram.editMessageText(
      entry.groupId,
      promptMsgId,
      `⏳ #${entry.no} 打回原因没等到 —— 请直接在群里发「打回 #${entry.no}：原因」（主 bot 监听这个格式回流小工）。`,
    ).catch(() => {});
    log(`[审核] #${entry.no} 打回原因条超时 → 已退回群里手打兜底`);
  }

  /** 插件实例 = 审核实例（老板 10-06 分工）。显式 BOT_ROLE=master/worker 时才关；
   *  现网 dshbot 实例没设 BOT_ROLE → 生效。 */
  const REVIEWER_MODE = !['master', 'worker'].includes(String(process.env.BOT_ROLE ?? '').trim());

  /** 找第一个「状态=待审核」的行（不限负责者 —— 审核覆盖所有小工的活）。 */
  function findReviewRow(table) {
    const lines = table.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\|\s*(\d+)\s*\|([^|]*)\|([^|]*)\|\s*待审核\s*\|/);
      if (m) return { index: i, line: lines[i], no: m[1], task: m[2].trim(), owner: m[3].trim() };
    }
    return null;
  }

  /** 卡片处理完改文案（防重复点击）；失败静默 —— 卡片留着顶多多按一次。 */
  async function editReviewCard(chatId, messageId, text) {
    if (!chatId || !messageId || !telegram) return;
    await telegram.editMessageText(chatId, messageId, text).catch(() => {});
  }

  /** 本地时间戳（结论列标记用）：MM-DD HH:MM，跟任务表既有留痕口径一致。 */
  function reviewClockTs() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 把「✅ 老板已通过（审核按钮 …）」写进任务表 #no 行结论列（任务 #25，2026-10-07）。
   *  为什么必须写表：TG 平台不向 bot 投递别的 bot 的发言 —— 群发那条「通过 #N」主 bot
   *  天生收不到（官方 Bots FAQ，任务表块头注释同款结论）；任务表是两边都在 5 秒轮询的
   *  共享账本（派活/交活同款通路）。行不在「待审核」→ 不写（防把已发布/打回的行翻旧账）；
   *  写入走 tmp+rename 原子替换。⛔ 只写事实标记，状态流转归主 bot。返回 true=写成功。 */
  function recordBossApproval(no, messageId) {
    const noStr = String(no);
    if (!/^\d+$/.test(noStr)) return false; // 回调数据只认数字行号，防注入正则
    const table = readTaskTable();
    if (!table) return false;
    const lines = table.split('\n');
    const i = lines.findIndex((l) => new RegExp(`^\\|\\s*${noStr}\\s*\\|`).test(l));
    if (i < 0) return false;
    const cells = lines[i].split('|');
    if (cells.length < 6 || cells[4].trim() !== '待审核') return false;
    const prev = cells[5].trim();
    const marker = `✅ 老板已通过（审核按钮 ${reviewClockTs()}，message_id=${messageId ?? '无回执'}）`;
    cells[5] = ` ${(prev && prev !== '—' ? `${prev}；` : '') + marker} `;
    lines[i] = cells.join('|');
    writeTaskTable(lines.join('\n'));
    return true;
  }

  async function sendReviewCard(row) {
    // 老板 id 必须已知：回调身份门（handleCallbackQuery）只用 state.ownerUserId 认老板，
    // 没认领就发卡 = 发一张谁都点不动的死卡。老板 id 唯一来源就是它，⛔ 不另立判定。
    if (!telegram || state.ownerUserId === null) return;
    const groupId = groupChatIdFromTable() ?? REVIEW_GROUP_FALLBACK;
    const taskBrief = row.task.length > 200 ? `${row.task.slice(0, 200)}…` : row.task;
    await telegram.sendMessage(
      groupId,
      [
        `📋 审核请求 #${row.no}（负责：${row.owner}）`,
        taskBrief,
        '',
        `✅ 通过 → 点按钮，我发「通过 #${row.no}」进协作群；❌ 打回 → 点 ❌ 后直接在群里发「打回 #${row.no}：原因」。`,
      ].join('\n'),
      {
        reply_markup: {
          inline_keyboard: [[
            { text: `✅ 通过 #${row.no}`, callback_data: `review:approve:${row.no}` },
            { text: `❌ 打回 #${row.no}`, callback_data: `review:reject:${row.no}` },
          ]],
        },
      },
    );
    log(`[审核] #${row.no} 审核卡片已发协作群`);
  }

  /** 审核轮：发现「待审核」行就发卡（挂在 watchTaskTable 的同一个 5s 轮询里）。 */
  function reviewTick(table) {
    if (!REVIEWER_MODE) return;
    const row = findReviewRow(table);
    if (!row || reviewCardsSent.has(row.no)) return;
    reviewCardsSent.add(row.no); // 先记后发：发送失败就移除，下一轮重试（成功恰好一次）
    sendReviewCard(row).catch((err) => {
      reviewCardsSent.delete(row.no);
      error(`[审核] #${row.no} 卡片发送失败，下轮重试: ${err?.message ?? err}`);
    });
  }
  watchTaskTable();

  // ---- 小工看门狗（任务 #32，2026-10-08：等价能力从 bot.js master 分支搬进插件源）----
  // bot.js 的 master 分支自主 bot 迁插件架构后无人执行，#9 小工看门狗随之失联
  // （实证：#28 进行中 5.5 小时无人翻牌改派）。判据与防风暴口径与 bot.js 版一致
  //（存活=pidfile kill -0 + 日志 15 分钟新鲜度；停摆=同状态 ≥30 分钟；拉活冷却
  // 10 分钟、连拉 3 次无效升级公告 —— 详见 src/herd.js 头注释）。
  // 全机只许一个插件实例看护：.herd.lock 选主，没选中的实例只留一行日志不巡检；
  // 停摆/判死结论合并成一条 sendRich 发协作群（群 id 表头优先，兜底协作群）。
  const herdDir = process.env.DSH_BOT_DIR ?? dirname(TASK_TABLE_PATH);
  // 协作群公告唯一实现（#33 抽出共用：herd 播报与任务表触发公告同一条发送腿，⛔ 不复制第二份）
  const announceGroup = async (text) => {
    const raw = groupChatIdFromTable() ?? HERD_GROUP_FALLBACK;
    const chatId = Number(raw);
    if (!telegram || !Number.isInteger(chatId)) throw new Error(`协作群 id 不可用（${raw ?? '无'}）`);
    return telegram.sendRich(chatId, text);
  };
  // 角色门（老板 2026-10-08 令「把插件版的看门狗去掉」+ #32 验收口径①）：只有 BOT_ROLE=master
  // 的实例才挂 —— 审核实例（默认，即插件版 @newdshbot）与小工实例（BOT_ROLE=worker）不挂、
  // 不播报、不抢 .herd.lock；看门狗能力由主 bot 侧 bot.js 老 herd 独跑承担，交接后再归这里。
  // 门控条件与下方 #33 taskTriggers 一字同款（同一份角色门口径，第 1 条）。
  let herd = null;
  if (String(process.env.BOT_ROLE ?? '').trim() === 'master') {
    herd = createHerdWatchdog({
      root: herdDir,
      lockPath: join(herdDir, '.herd.lock'),
      readTable: readTaskTable,
      writeTable: writeTaskTable,
      announce: announceGroup,
      log,
      error,
    });
    herd.start();
  } else {
    log('[herd] 本实例非 master（BOT_ROLE 未设 = 审核模式）—— 小工看门狗不开（归主 bot 实例）');
  }

  // ---- 主 bot 侧任务表自动触发（任务 #33，2026-10-08：bot.js watchTaskTable 的插件等价）----
  // 每 5 分钟（与看门狗同拍）扫任务表：「待验收」→ 群发「🔔 验收触发 #N」+ 行占位「验收中」
  // + 验收 prompt 注入本会话；「待审核+通过标记」→ 群发「🔔 发版触发 #N」+ 占位「发布中」
  // + 发版 prompt 注入。光群发叫不醒会话（TG 不投 bot 发言），注入才是叫醒腿（领活同款通路）。
  // 失败重试不丢：公告失败行不动、注入失败行回滚（详见 src/triggers.js 头注释）。
  // 角色门：只有 BOT_ROLE=master 的实例跑 —— 审核实例（默认）与 worker 实例不设即不跑，
  // 验收/发版轮只归主 bot；多实例误配双 master 也有 .trigger.lock 选主兜底。
  let taskTriggers = null;
  if (String(process.env.BOT_ROLE ?? '').trim() === 'master') {
    taskTriggers = createTaskTriggers({
      lockPath: join(herdDir, '.trigger.lock'),
      readTable: readTaskTable,
      writeTable: writeTaskTable,
      announce: announceGroup,
      chatId: () => {
        const g = groupChatIdFromTable();
        return g ? Number(g) : state.ownerUserId; // bot.js 原版兜底（群 id 缺失时私聊）
      },
      inject: (chatId, text) => enqueue(`tg:${chatId}`, () => promptFromHub({ source: 'tg', chatId, text, raw: null })),
      log,
      error,
    });
    taskTriggers.start();
  } else {
    log('[触发器] 本实例非 master（BOT_ROLE 未设 = 审核模式）—— 任务表自动触发不开（归主 bot 实例）');
  }

  // （互为看门狗 #11 已按老板令于 2026-10-07 整体删除：互相保活=互相误杀，把健康的
  //   主 bot 反复 kickstart 勒死——任务表 #12/#13 有案。当时为它加的 [hb] 心跳保留，
  //   日志活性对人工排查有用，已无人拿它当判死依据。）

  // 卸载
  // -------------------------------------------------------------------------
  const hbTimer = setInterval(() => log('[hb] 心跳正常（插件活、事件循环通）'), 5 * 60 * 1000);

  ctx.on('dispose', async () => {
    state.stopped = true;
    if (taskTimer) clearInterval(taskTimer);
    if (hbTimer) clearInterval(hbTimer);
    herd?.stop(); // 看门狗定时器 + .herd.lock（只删自己的锁；非 master 实例未挂 = 空转）
    taskTriggers?.stop(); // 触发器定时器 + .trigger.lock（#33；没 start 过则空转）
    approvalBridge?.dispose();
    pollAbort?.abort();
    wxAbort?.abort();
    // 锁是自己的才删（release 内部核对 pid）：这期间可能已被别的实例接管。
    await lock?.release();
    await hub.stop().catch(() => {});
    await runtime.stop().catch((err) => error(`关闭运行时失败: ${err?.message}`));
    log('插件已卸载，轮询已停止');
  });

  log(`已挂载 — 入口 [${hub.ids().join(', ') || '无'}] 模型 ${activeRoute ? activeRoute.key : '(未配置)'}`);

  // ⚠️ 「装上了但没配」必须吼出来，不能静默假装挂载成功。
  //    这是插件类产品最常见也最难排查的失败：用户以为装好了，发消息石沉大海，
  //    日志里只有一行「已挂载」，看不出到底缺什么。
  if (!config.telegramToken && !weixinReady) {
    error(
      '两个入口都没有配置 —— 插件不会有任何反应。' +
        '请至少填 telegramToken（Telegram）或 weixinToken（微信）。',
    );
  }
  if (useHostRoutes) {
    // 宿主模型表要查 llm 服务（可能异步），异步补算默认档后再判空。
    void (async () => {
      try { await refreshHostRoute(); } catch { /* 表读不到按空处理 */ }
      if (!activeRoute) {
        error('没有可用的模型档位 —— 收到消息也无法回答。请在 web 端模型页添加模型，或在 config.routes 里手写档位。');
      } else {
        log(`模型档位已就绪 — 默认 ${activeRoute.key}（跟随 web 端模型页）`);
      }
    })();
  } else if (!activeRoute) {
    error('没有可用的模型档位 —— 收到消息也无法回答。请在 web 端模型页添加模型，或在 config.routes 里手写档位。');
  }
}

// 保留导出，方便别处（测试）复用
// （createInstanceLock 在上面就地具名导出：单实例锁要能被隔离测试直接调用）
export { markAsHubOutput, makeMessage, isRouteFailure, routeFor };

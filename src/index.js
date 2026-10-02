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
import { existsSync, openSync, appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  // 默认走阿里 FunASR SenseVoice（本机语音引擎），路径留空会自动找 /opt/homebrew/bin 下的。
  // 没配也没有 → 收到语音时回「一条能直接粘的安装命令」，而不是 ENOENT。
  asrBackend: Schema.string().default('sensevoice')
    .description('语音转文字后端：sensevoice（默认，阿里 FunASR，中文准）或 whisper（中文差，要用得显式填）'),
  asrWhisperBin: Schema.string().description('whisper 可执行文件路径（只有 asrBackend=whisper 时才用到）'),
  asrPythonBin: Schema.string().description('python 解释器路径（sensevoice 用，默认 /opt/homebrew/bin/python3.11）'),
  asrKeepalive: Schema.boolean().default(false)
    .description('是否启用常驻转写服务（省掉每次约 7 秒的模型加载，代价是常驻约 1.5GB 内存）'),
  asrKeepalivePort: Schema.number().default(18081).description('常驻服务端口'),
  asrKeepaliveScript: Schema.string()
    .description('常驻转写服务的脚本路径（asr-server.py）。不填则不用常驻'),
  asrMemoryLimitGb: Schema.number().default(16)
    .description('内存超过这么多 GB 就不启用常驻服务（避免和本地大模型抢内存）'),

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
const LOCK_BUSY_NOTICE = '⚠️ 检测到已有另一份实例在跑（单实例锁被占）。我这边先不轮询，每 60 秒重试一次，等它退出后自动接上。如果机器人一直不回话，请检查是否有两份实例在跑（比如重复双击了启动器）。';

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
 * 判定规则（锁文件内容就是一行 pid）：
 *   - 文件不存在        → 独占创建（flag 'wx' 原子：两个实例同时启动也只有一个赢）；
 *   - 里面的 pid 还活着 → 让位：本次不轮询，由调用方 60 秒后再来（见 LOCK_RETRY_MS）；
 *   - pid 已死 / 内容坏 / 就是自己 → 陈旧残留（断电、被 kill 留下的），直接接管。
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

  /** 尝试获取。true = 现在可以轮询（含 fail-open 的情况）。 */
  async function acquire() {
    try {
      try {
        // 'wx' = 独占创建：文件已存在就 EEXIST，绝不覆盖别人写的 pid。
        await writeFile(lockPath, String(process.pid), { flag: 'wx' });
        held = true;
        log(`已取得单实例锁（${lockPath}，pid ${process.pid}）`);
        return true;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
      }

      const raw = String(await readFile(lockPath, 'utf8').catch(() => '')).trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
        log(`单实例锁被活着的 pid ${pid} 持有 —— 本实例先不轮询，${LOCK_RETRY_MS / 1000} 秒后再看`);
        return false;
      }

      // pid 是死的（僵尸残留）/ 内容坏掉 / 就是自己（不可能有两个同 pid 的进程）→ 接管。
      await writeFile(lockPath, String(process.pid));
      held = true;
      log(`单实例锁是陈旧残留（文件里的 pid：${raw || '(空)'}）—— 已接管（pid ${process.pid}）`);
      return true;
    } catch (err) {
      // fail-open：拿锁本身出问题，不能连累 bot 不工作。
      error(`单实例锁不可用（${err?.message}）—— 继续运行，只是失去这层保护`);
      held = true;
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
    try {
      const raw = await readFile(lockPath, 'utf8').catch(() => null);
      if (raw === null) return; // 文件已经不在了
      if (Number.parseInt(String(raw).trim(), 10) !== process.pid) return; // 已经是别人的锁
      await unlink(lockPath);
      log('已释放单实例锁');
    } catch (err) {
      if (err?.code !== 'ENOENT') error(`释放单实例锁失败: ${err?.message}`);
    }
  }

  return { acquire, release, path: lockPath, get held() { return held; } };
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
  try {
    // 同步读：文件只有几十字节，且 apply() 不是 async（不能用 await）。
    const saved = JSON.parse(readFileSync(pickedKeyFile, 'utf8'));
    // ⚠️ 只认非空字符串。**不**在这里判"档位还有效吗" —— 见上面那段定案：
    //    有效性不该由插件猜，猜错一次用户的档位就没了。
    if (saved && typeof saved.hostPickedKey === 'string' && saved.hostPickedKey.trim()) {
      hostPickedKey = saved.hostPickedKey;
    }
  } catch { /* 文件不存在 / JSON 坏了 → 当没有记忆，照常回落默认档 */ }
  /** 记住用户手选的档位（含落盘）。⚠️ 只该在用户**手点切换**时调用。 */
  const rememberPickedKey = (key) => {
    if (hostPickedKey === key) return;
    hostPickedKey = key;
    try {
      writeFileSync(pickedKeyFile, JSON.stringify({ hostPickedKey: key }, null, 2));
    } catch { /* 写不了不影响本次运行，只是重启后仍会回落 */ }
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
  // 主人所在会话：私聊里 chat id == user id（与 tgEndpoint 同款约定）。
  // 主人还没认领（ownerUserId 为 null）时返回 null → 桥不接管，走失败关闭。
  approvalBridge = installApprovalBridge({
    ctx,
    telegram,
    getChatId: () => (telegram && state.ownerUserId !== null ? state.ownerUserId : null),
    log,
    error,
  });

  // -------------------------------------------------------------------------
  // 最高指令（HARD-RULES.md）：每动一次手，就把原文重新顶进上下文
  // -------------------------------------------------------------------------
  // 用户 2026-10-02 定：不是「开头读过一次就算」，而是「每动若干次手就再出现一次」，
  // 否则干着干着就忘了。频率 = 第 1 次 + 之后每 10 次（见 HARD_RULES_EVERY_N）。
  //
  // 机制：DSH 的 `tools/post-execute` 是 waterfall（dsh-tools/lib/index.js:3504），
  // 监听者可以返回 `{ kind: 'accept', additionalContexts: [message] }` ——
  // 这些 context 会被原样 splice 进 loop 的 next-step inbox
  // （dsh-agent-loop/lib/index.js:1154，**不做任何形状校验**），
  // 于是它作为一条独立消息出现在我下一次请求里。
  //
  // ⚠️ 刻意**不**引 `@deepseek-ai/dsh-llm` 的 createUserMessage：本插件坚持零内部
  //    依赖（见文件开头）。上游只 splice 不校验，所以这里手搓同形状的 user message。
  // ⚠️ 文件在**启动时读一次**并缓存（用户 2026-10-02 定）—— 改完内容要重启 bot 才生效。
  // ⚠️ 只挂「动手」类工具；read / grep / glob 这些不挂，省 token。
  const HARD_RULES_PATH = new URL('../HARD-RULES.md', import.meta.url);
  const HARD_RULES_TOOLS = new Set(['bash', 'edit', 'write', 'str-replace', 'str_replace']);
  /**
   * 每多少次动手类调用才注入一次。
   * 用户 2026-10-02 定：每次都注入太频繁（一次任务动 20 次手要堆 20 份规则 ≈ 6000 token）。
   * 计数规则：第 1 次就注入（开工先看到规则），之后每 N 次再来一次（1, N+1, 2N+1…）。
   * ⚠️ 口径必须与 `DSH/hard-rules/index.mjs`（本机那份）保持一致。
   */
  const HARD_RULES_EVERY_N = 10;
  let hardRulesText = '';
  try {
    hardRulesText = readFileSync(HARD_RULES_PATH, 'utf8').trim();
  } catch {
    hardRulesText = '';
  }
  if (hardRulesText.length > 0) {
    /** 动手类调用计数（插件实例级，ctx / ctx.root 两次挂载共用）。 */
    let hardRulesCalls = 0;
    /** ⚠️ 同一次调用会被 ctx 与 ctx.root 两个挂载**各触发一次** —— 按 exec 对象身份去重，
     *  保证「一次动手只计 1」。否则 HARD_RULES_EVERY_N=10 实际每 5 次就注一次
     *  （2026-10-02 实测：注入落在第 1,6,11,16… 次动手）。 */
    let hardRulesLastExec = null;
    const hardRulesHandler = (exec, _result, next) => {
      if (!HARD_RULES_TOOLS.has(String(exec?.name ?? ''))) return next();
      if (exec !== hardRulesLastExec) {
        hardRulesLastExec = exec;
        hardRulesCalls += 1;
      }
      // 第 1 次就注入（开工先看到规则），之后每 HARD_RULES_EVERY_N 次一次：1, N+1, 2N+1…
      if (hardRulesCalls % HARD_RULES_EVERY_N !== 1) return next();
      return {
        kind: 'accept',
        additionalContexts: [{
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: hardRulesText }],
          source: { kind: 'hard-rules' },
        }],
      };
    };
    // ⚠️ 挂两份（ctx + ctx.root）：`tools/post-execute` 是 agent 作用域事件，
    //    插件根 ctx 通常收得到，但被挂到不相关 scope 下就会漏 —— 与
    //    approval-bridge.js 同款做法（理由见其文件头注释）。waterfall 在第一个
    //    返回决定值的监听者处终止，所以两份不会重复注入。
    const targets = ctx.root && ctx.root !== ctx ? [ctx, ctx.root] : [ctx];
    let mounted = 0;
    for (const target of targets) {
      if (typeof target?.on !== 'function') continue;
      try {
        target.on('tools/post-execute', hardRulesHandler);
        mounted += 1;
      } catch (err) {
        log(`最高指令挂载失败: ${err?.message ?? err}`);
      }
    }
    log(`最高指令已挂载（${mounted} 处 / ${hardRulesText.length} 字）：${HARD_RULES_PATH.pathname}`);
  } else {
    log(`最高指令文件为空或不存在，跳过挂载：${HARD_RULES_PATH.pathname}`);
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
    while (!state.stopped) {
      let updates;
      try {
        updates = await telegram.getUpdates(offset, 30, pollAbort?.signal);
        // 这一轮拿到了（哪怕是空数组）说明此刻没人和我们抢 → 冲突计数归零。
        conflictStreak = 0;
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
        if (!/abort/i.test(err.message ?? '')) {
          error(`getUpdates 失败: ${err.message}`);
        }
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
    }
  }

  /**
   * 处理一条 Telegram 消息。
   *
   * 统一路径：TG → hub.inbound → ① 交给 DSH ② 镜像到其他端点。
   *    不要写成对镜像（mirrorTgToWeixin 那种）—— 那是 O(n²)。
   */
  async function handleTelegramMessage(message) {
    const chatId = message.chat.id;
    const userId = message.from?.id;

    const decision = authorize(userId);
    if (!decision.ok) {
      const why =
        decision.reason === 'not-owner'
          ? `这个 bot 已经绑定了别的用户。你的 Telegram 用户 ID 是 ${userId}。`
          : `你没有权限使用这个 bot。你的 Telegram 用户 ID 是 ${userId}。`;
      await telegram.sendMessage(chatId, why);
      return;
    }

    const rawText = (message.text ?? message.caption ?? '').trim();

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
    // Telegram 要求每次按钮按下都必须应答，哪怕后续动作失败。
    await telegram.answerCallbackQuery(query.id).catch(() => {});
    const userId = query.from?.id;
    if (!authorize(userId).ok) return;
    const data = String(query.data ?? '');
    // 审批按钮（appr:ok:/appr:no:）优先于模型菜单处理。
    if (approvalBridge?.handleApprovalCallback(data, query)) return;
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
    // ⚠️ launchd 例外：bot.sh daemon 用 exec node bot.js，exit 0 时
    // plist 的 SuccessfulExit=false 判定为"正常退出"→ 不重拉。
    // 如果走 RESTART_SUPERVISED 路径，helper 只杀进程等 launchd 拉起 → 永远等不到。
    // 所以 launchd 必须走 hasLauncher / 原始命令行路径，让 helper 自己 nohup 拉起。
    const supervisor = process.env.INVOCATION_ID ? 'systemd' : null;
    if (!hasLauncher && !scriptPath && !supervisor) return null;
    return {
      RESTART_DELAY_SECONDS: '8',
      RESTART_TARGET_PID: String(process.pid),
      RESTART_LOG: join(cwd, 'dsh-restart.log'),
      // 被托管：只杀宿主，交给托管者拉起（helper 内不再 nohup / 不再 open 启动器）
      ...(supervisor
        ? { RESTART_SUPERVISED: supervisor }
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
              '点上面的按钮切换。切换后当前会话的完整历史由新模型接着用（上下文保留，不会丢）。',
              '',
              // ⚠️ 文案必须跟着机制走：跟随宿主时根本没有「回退顺序」——
              //    真实依据是 web 端「设置 → 模型」里那份表的默认档。
              useHostRoutes ? '可选档位（跟随 web 端「设置 → 模型」）：' : '启动回退顺序：',
              ...picks.map((r) => `  ${r.short}`),
              '',
              '需要远程重启 bot 加载新代码，请在命令列表里选「重启」（位于「切换模型」与「查看当前会话」之间，效果等同 /restart，会断开当前会话）。',
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
              '',
              useHostRoutes ? '可选档位（跟随 web 端「设置 → 模型」）:' : '自动回退顺序:' + picks.map((r) => `\n- ${r.short}`).join(''),
              '',
              '⚠️ 切换后当前会话历史由新模型接着用（上下文保留）。',
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
        await runtime.closeSession(chatKey);
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
        await runtime.closeSession(chatKey);
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
          await telegram.sendMessage(chatId, '⬆️ 正在启动 SetupDSH&BOT 升级…', {
            parse_mode: 'HTML',
          });
          const child = spawn('bash', [helper], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env },
          });
          child.unref();
          return true;
        }
        await reply('⚠️ 未找到 setupdsh-helper.sh，无法执行升级。');
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
      .then((info) => log(`Telegram 已登录：@${info.username} (${info.id})`))
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
    while (!state.stopped && !(await lock.acquire())) {
      waits += 1;
      // 大声说一次就够，重试本身每 60 秒都会在 acquire 里留下可读的日志。
      if (waits === 1) {
        error('');
        error('❌ 单实例锁被另一个活着的进程持有 —— 本实例暂不轮询（不会退出进程）。');
        error('   常见原因：同一个 token 有两份实例在跑（比如重复双击了启动器）。');
        error(`   每 ${LOCK_RETRY_MS / 1000} 秒重试一次，那份实例退出后本实例会自动接上。`);
      }
      // 通知同样节流：第 1 次 + 之后每 10 次一次（≈10 分钟），别刷屏。
      if (waits === 1 || waits % 10 === 0) await notifyOwner(LOCK_BUSY_NOTICE);
      await sleepAbortable(LOCK_RETRY_MS, pollAbort?.signal);
    }
    if (state.stopped) {
      // 等锁期间被卸载：锁若刚好被自己拿到就还回去，别给下一个进程留僵尸锁。
      await lock.release();
      return;
    }
    await pollLoop();
  }

  // 两个轮询并行跑；单个挂掉不影响另一个（微信没登录也必须让 TG 照跑）。
  Promise.all([telegramPollWhenLocked(), weixinPollLoop()]).catch((err) =>
    error(`轮询循环异常退出: ${err?.stack ?? err?.message}`),
  );

  // -------------------------------------------------------------------------
  // 卸载
  // -------------------------------------------------------------------------
  ctx.on('dispose', async () => {
    state.stopped = true;
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

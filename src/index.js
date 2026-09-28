/**
 * dsh-botplugin — Telegram / WeChat 接入层 + handoff 记忆衔接。
 *
 * 三样功能（用户 2026-09-27 定的范围）：
 *   ① Telegram 入口（长轮询）
 *   ② 微信入口（iLink 长轮询）
 *   ③ handoff（会话断开前把进展落盘，新会话读回来接上）
 *
 * ⚠️ 与 `BOT/` 的关系：这是**另一个项目**，把 BOT 里已经验证过的逻辑搬过来，
 *    改造成「装在 DSH 进程里的插件」。BOT 本体不受影响、继续照跑。
 *    两者的根本差别：BOT 是**独立进程**（`dsh.js` spawn 一个 `dsh --profile sdk`
 *    子进程，靠 stdio JSON-RPC 说话）；插件**活在 DSH 进程内部**，
 *    所以那一整层子进程管理代码在这里不存在，直接调 `ctx.agents`。
 *
 * Cordis 插件约定：
 *   - 具名导出 `name` / `inject` / `Config` / `apply`，**不要 default 导出**
 *     （Loader 的 unwrapExports 靠具名导出保留插件身份）。
 *   - `name` 是插件在 loader 树里的名字，与 `cordis.patch.yml` 里的行 id 分开。
 *   - `inject` 列出依赖的服务名；服务齐了 `apply()` 才会被调用。
 *
 * ⚠️ 本插件**不 import 任何 `@deepseek-ai/*` 内部包**（除了可选的 schemastery）。
 *    实测从插件目录解析不到那些包（见 probe-resolution.mjs），且 `NODE_PATH`
 *    对 ESM 无效。需要的东西全部经由 `ctx` 服务和本地实现拿。
 */

import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Schema } from './schema.js';
import { Telegram } from './telegram.js';
import { Weixin } from './weixin.js';
import { Memory } from './memory.js';
import { BotRuntime } from './runtime.js';
import { Hub, makeMessage, markAsHubOutput } from './hub.js';
import { buildRoutes, routeByKey, routeFor, describeRoute, isRouteFailure } from './models.js';
import { transcribe, configure as configureAsr, currentBackend } from './asr.js';

/** Cordis 插件名。 */
export const name = 'botplugin';

/**
 * 依赖的服务。
 *
 * ⚠️ `agents` 是**硬依赖**：没有它这个插件没有任何意义（收进来的消息没法交给模型）。
 *    Cordis 会等它出现才调 `apply()`。
 */
export const inject = ['agents'];

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
    .description('模型路由表。留空 = 跟随 web 端模型页（settings.yaml）增减的模型与默认档'),
  defaultRouteKey: Schema.string().description('默认走哪条路由（仅手写 routes 时有效）'),

  // ---- 工作区与记忆 ----
  cwd: Schema.string().description('会话工作目录。留空 = 用 DSH 当前目录'),
  memoryDir: Schema.string().description('记忆目录（每项目独占）。留空 = 不启用 handoff'),
  memoryScript: Schema.string().description('共享的 cache-manager.mjs 路径（记账用）'),

  // ---- 行为 ----
  backlogMaxAgeSeconds: Schema.number().default(2 * 60 * 60)
    .description('停机太久时，超过这个年龄的积压消息不再执行（默认 2 小时）'),
  turnTimeoutMs: Schema.number().default(30 * 60 * 1000)
    .description('等模型回答的超时（毫秒，默认 30 分钟）。超时后该会话的队列才会解锁'),
  logLabel: Schema.string().default('botplugin').description('日志前缀'),

  // ---- 语音转文字 ----
  // ⚠️ 这三个路径**没有默认值**，因为默认值只能是作者本机的布局（Homebrew）。
  //    留空时收到语音会给一条「请设置 xxx」的可操作报错，而不是 ENOENT。
  asrBackend: Schema.string().default('whisper')
    .description('语音转文字后端：whisper 或 sensevoice（中文更准）'),
  asrWhisperBin: Schema.string().description('whisper 可执行文件路径，如 /opt/homebrew/bin/whisper'),
  asrPythonBin: Schema.string().description('python 解释器路径（sensevoice 后端用）'),
  asrKeepalive: Schema.boolean().default(false)
    .description('是否启用常驻转写服务（省掉每次约 7 秒的模型加载，代价是常驻约 1.5GB 内存）'),
  asrKeepalivePort: Schema.number().default(18081).description('常驻服务端口'),
  asrKeepaliveScript: Schema.string()
    .description('常驻转写服务的脚本路径（asr-server.py）。不填则不用常驻'),
  asrMemoryLimitGb: Schema.number().default(16)
    .description('内存超过这么多 GB 就不启用常驻服务（避免和本地大模型抢内存）'),
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
 * Telegram 返回 409 时另一个进程正在轮询同一个 bot token。
 *
 * ⚠️ 这一个 token 只能有一个进程 —— 第二个进程会让先启动的那个收 409，
 *    而它「收不到消息」的表现看起来就像 bot 随机不理人。
 *    插件版**不能**像 BOT 那样 `process.exit(3)`（那是宿主进程，会拖垮整个 DSH），
 *    所以这里只报错并**停掉自己的轮询**，把问题留在明面上。
 */
function isConflict(err) {
  return err?.errorCode === 409
    || /terminated by other getUpdates/i.test(String(err?.description ?? err?.message ?? ''));
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
  //    ② routes 留空 → **跟随宿主模型表**（web 端 settings.yaml 增减模型即时生效）：
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

  // ── 宿主模型表：与 BOT 的 sync-from-web.mjs **同一套规则**（用户 2026-09-19 定死）──
  //    单一事实源 = web 端「设置 → 模型」；插件在宿主进程内，直接读 settings 服务，
  //    连 BOT 需要的 web-models.json 同步缓存都省了。差别只有这一点。
  //    key 规则照抄 sync-from-web.mjs:177：单模型 provider 用别名，多模型 `<别名>:<模型id>`。
  const KEY_ALIAS = { alibailian: 'ali', 'deepseek-official': 'ds', qwen36vq: 'local', qwen36iq4xs: 'iq4' };
  const menuKey = (pid) => KEY_ALIAS[pid] ?? pid;
  const routeKeyFor = (pid, modelId, isOnlyModel) => {
    const alias = menuKey(pid);
    return isOnlyModel ? alias : `${alias}:${modelId}`;
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

    // ① 自定义 provider（llm-pi-ai.providers.*）—— 与 sync-from-web.mjs:232 同构
    const providers = readSection('llm-pi-ai')?.providers ?? {};
    for (const [pid, p] of Object.entries(providers)) {
      const models = (Array.isArray(p?.models) ? p.models : []).filter((m) => m?.id);
      if (models.length === 0) continue;
      if (live.size > 0 && !live.has(pid)) continue;
      const label = p?.displayName ?? pid;
      for (const m of models) {
        list.push({
          key: routeKeyFor(pid, m.id, models.length === 1),
          label,
          short: `${label}:${m.name ?? m.id}`,
          provider: pid,
          model: m.id,
          displayName: m.name ?? m.id,
          reasoningEffort: p?.reasoning ?? 'off',
          isDefault: def?.provider === pid && def?.model === m.id,
        });
      }
    }

    // ② 内置 deepseek（llm-deepseek）—— 与 sync-from-web.mjs:256 同构。
    //    web 端通常不声明 models；声明了以声明为准，否则向 llm 服务查动态目录
    //    （sync 脚本是从插件源码读 DEFAULT_MODELS，进程内直接调 listModels 更准）。
    const dsSection = readSection('llm-deepseek') ?? {};
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
          reasoningEffort: dsSection.reasoningEffort ?? 'off',
          isDefault: def?.provider === 'deepseek-official' && def?.model === id,
        });
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
    activeRoute = table.list.find((r) => r.key === table.defaultKey) ?? null;
    runtime?.setDefaultRoute(activeRoute);
    return activeRoute;
  };

  // -------------------------------------------------------------------------
  // 记忆（handoff）
  // -------------------------------------------------------------------------
  const memory = config.memoryDir
    ? new Memory({
        memoryDir: config.memoryDir,
        memoryScript: config.memoryScript || null,
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
  /** 微信的 context_token 缓存：userId → token。入站消息带来新鲜的。 */
  // ⚠️ 必须在 Weixin 构造**之前**声明：构造函数会把下面的 onInvalidate
  //    闭包存起来，虽然它要到重连时才执行（那时已初始化完），但把声明
  //    放在使用点之后是靠 TDZ 侥幸，读代码的人会以为有 bug。
  const wxContextTokens = new Map();

  const weixin = new Weixin({
    apiRoot: config.weixinApiRoot || undefined,
    accountFile: config.weixinAccountFile || undefined,
    // 重连时让缓存真的被清掉。BOT 原版在 reconnect() 里清两个**不存在**的字段，
    // 等于空操作；插件版把缓存放在下面的 wxContextTokens，所以在这里挂钩子。
    onInvalidate: () => {
      wxContextTokens.clear();
      log('微信 context_token 缓存已清空（重连）');
    },
  });
  // 微信凭据：优先配置里的 token；没有则回落到凭据文件（原版行为）。
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
   * ⚠️ 白名单通过的同时**也要认领主人锚点**。BOT 原逻辑：白名单分支直接 return，
   *    **从不执行认领** → ownerUserId 永远是 null →
   *    ① 微信入口拿到 null 锚点，回「尚未绑定主人」
   *    ② 节点广播「微信入站 → TG」时没有投递目标 → `chat not found`
   *    （BOT 2026-09-19 实测踩过）。白名单里的人天然可信，认领不会放宽权限。
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
      // ⚠️ 这里**不能**按 source 过滤。
      //    曾经的写法是「TG 的入站在 pollLoop 里自己交给 DSH」，那是搬运时
      //    留下的错注释 —— handleTelegramMessage 只调 hub.inbound，没有第二条路。
      //    结果：TG 消息全部被静默丢弃（实测复现：用户发消息，日志有
      //    「[hub] 入站」，但既不建会话也不回话）。两端都走同一条路。
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
    async send(msg) {
      if (!weixin.enabled) return;
      const to = config.weixinAllowedUserId || weixin.ownerWxUserId || state.ownerUserId;
      if (!to) return;
      await weixin.sendText(String(to), msg.text, wxContextTokens.get(String(to)) ?? undefined);
    },
  };

  if (telegram) hub.add(tgEndpoint);
  if (weixinReady) hub.add(wxEndpoint);

  // -------------------------------------------------------------------------
  // 排队：同一个会话的回合必须串行
  // -------------------------------------------------------------------------
  /** chatKey → Promise 链尾。 */
  const queues = new Map();

  /**
   * 把任务排进某会话的队列。
   *
   * ⚠️ 为什么必须串行：DSH 的 `agent.followup()` 是**排队语义**，同一个 agent
   *    同时收到两条 prompt 会交错。BOT 当年也有一层同样的队列。
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
   * 把一条用户消息交给 DSH，并把回答送回来。
   *
   * ⚠️ **顺序至关重要**：`waitForTurn()` 必须在 `runtime.prompt()` **之前**订阅。
   *    反过来的话，建会话和跑第一轮之间有个窗口，快速回答的事件会在订阅前
   *    就发完 → 表现是「偶尔第一条消息没回答」，极难复现。
   *
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function promptFromHub(msg) {
    const chatKey = `${msg.source}:${msg.chatId}`;
    const text = String(msg.text ?? '').trim();
    if (!text) return { ok: false, error: '空消息' };

    if (!sessionCreatedAt.has(chatKey)) sessionCreatedAt.set(chatKey, Date.now());
    memory?.ledgerRecord('user', text, chatKey);

    // 宿主模式下先刷新默认档 —— web 端加减模型/换默认，下一条消息就生效。
    await refreshHostRoute();

    const ep = msg.source === 'tg' ? tgEndpoint : wxEndpoint;

    // ① 先订阅，后发消息
    const waiting = runtime.waitForTurn(chatKey, config.turnTimeoutMs);

    // ② 发给 DSH
    const sent = await runtime.prompt(chatKey, text);
    if (!sent.ok) {
      error(`交给 DSH 失败（${chatKey}）: ${sent.error}`);
      await ep.send({ text: `❌ 处理失败：${sent.error}` }).catch(() => {});
      return sent;
    }

    // ③ 等回答
    const answer = await waiting;
    if (!answer.ok) {
      error(`等回答失败（${chatKey}）: ${answer.error}`);
      await ep.send({ text: `❌ ${answer.error}` }).catch(() => {});
      return { ok: false, error: answer.error };
    }

    const body = answer.text || '(本轮没有文字输出)';
    memory?.ledgerRecord('assistant', body, chatKey);
    // 交给用户 —— 走端点自己的发送能力（TG 会做 markdown 转换和长度切分）
    await ep.send({ text: body }).catch((err) => error(`发送失败（${chatKey}）: ${err?.message}`));
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Telegram 长轮询
  // -------------------------------------------------------------------------
  let offset = 0;
  let pollAbort = null;

  /**
   * Telegram 轮询主循环 —— 从 BOT/bot.js 的 `pollLoop()` 搬运。
   *
   * ⚠️ 游标语义（BOT 踩过的坑，原样保留）：
   *    - **不能**用 `getUpdates(-1)` 去"探一下最新" —— 那等于告诉 Telegram
   *      中间那些更新都收到了，停机期间的消息会被**静默丢弃**，日志还很干净。
   *    - `offset` 推进和 `lastUpdateId` 持久化**两半都要**。只持久化不推进，
   *      `getUpdates` 每轮都把同一批还回来 → 无限重放刷屏（BOT 2026-09-12 出过）。
   *      插件版暂无自己的持久化文件，所以 offset 只在内存里（进程重启会重来，
   *      但这比写错文件安全；要持久化应走 DSH 的存储服务，另开一轮做）。
   */
  async function pollLoop() {
    if (!telegram) return;
    log('Telegram 轮询启动');
    while (!state.stopped) {
      let updates;
      try {
        updates = await telegram.getUpdates(offset, 30, pollAbort?.signal);
      } catch (err) {
        if (state.stopped) break;
        if (isConflict(err)) {
          error('');
          error('❌ 409 Conflict：另一个进程正在用同一个 bot token 收消息。');
          error('   本插件的 Telegram 轮询**已停止**（没有退出 DSH 进程）。');
          error('   常见原因：BOT 本体也在用这个 token 跑，或者起了两份插件。');
          error('   ⛔ 同一个 token 只能有一个进程 —— 请只留一个。');
          return; // ⚠️ 不能 process.exit：那是宿主进程
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
   * ⚠️ 与 BOT 的差异：BOT 里 TG 的消息走向是
   *      TG → (mirror) hub → 微信   然后   TG → DSH
   *    插件版统一成**一条路**：TG → hub.inbound → ① DSH ② 其他端点。
   *    这正是 hub.js 文件头写的架构（「端点 → 节点 → ① DSH ② 其他所有端点」），
   *    也是 BOT 当年没走完的那半步（bot.js:3011 注释：「入站归一化是下一步」）。
   *    ⛔ 不要再写成对镜像（mirrorTgToWeixin 那种）—— 那是 O(n²)。
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
      const [command] = rawText.split(/\s+/);
      const handled = await handleCommand(chatId, userId, command.toLowerCase().split('@')[0]);
      if (handled) return;
    }

    /** 组装成 DSH 能收的内容块。 */
    const blocks = [];
    if (rawText) blocks.push({ type: 'text', text: rawText });

    // ---- 图片 ----
    // SDK 约定（@deepseek-ai/dsh-sdk-jsonrpc-server 的 encodedImage 判据）：
    //   { type: 'image', data: <canonical base64>, mimeType: 'image/png' }
    // ⚠️ BOT 踩过：只声明了 inputModalities 却**从没把图片块压进 blocks**，
    //    所以无论配置怎么改，图片都被静默丢掉，模型只收到文字。
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
          mimeType: imageDocument?.mime_type ?? 'image/jpeg',
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
        await telegram.sendMessage(chatId, `❌ 语音转文字失败：${err.message}`);
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
    if (data.startsWith('model:')) {
      await handleCommand(query.message.chat.id, userId, '/model', data.slice(6));
    }
  }

  /**
   * 斜杠命令。
   *
   * ⚠️ 已实现的是**插件自己就能完成**的那几个。/restart、/new 这类需要
   *    「重启 DSH 进程」或「清空会话」的命令，语义与独立进程的 BOT 不同，
   *    留到后面单独定（见 plan.md）。
   *
   * @returns {Promise<boolean>} true = 已处理（调用方不要再当普通消息发）
   */
  async function handleCommand(chatId, userId, command, arg = '') {
    switch (command) {
      case '/whoami':
        await telegram.sendMessage(chatId, `你的 Telegram 用户 ID：${userId}`);
        return true;

      case '/status': {
        const lines = [
          '📊 插件状态',
          `• 会话数：${runtime.sessionCount}`,
          `• 当前模型：${activeRoute ? describeRoute(activeRoute) : '(未配置)'}`,
          `• 工作目录：${config.cwd || process.cwd()}`,
          `• 入口：${hub.ids().join(' + ') || '(无)'}`,
          `• 记忆：${memory ? config.memoryDir : '未配置'}`,
        ];
        await telegram.sendMessage(chatId, lines.join('\n'));
        return true;
      }

      case '/model': {
        // 宿主模式下实时重建表单：web 端刚加的模型立刻能看到。
        const table = useHostRoutes ? await hostModelTable() : { list: routeList };
        const lookup = (key) =>
          useHostRoutes ? table.list.find((r) => r.key === key) : routeByKey(routes, key);
        const current = useHostRoutes ? await refreshHostRoute() : activeRoute;
        if (!arg) {
          const list = table.list.map((r) => `• ${r.key} — ${describeRoute(r)}`).join('\n');
          await telegram.sendMessage(
            chatId,
            `当前：${current ? current.key : '(未配置)'}\n\n可用模型：\n${list || '(未配置任何模型 —— 在 web 端的模型页添加，或在本插件 config.routes 里手写)'}\n\n用法：/model <key>`,
          );
          return true;
        }
        const wanted = lookup(arg);
        if (!wanted) {
          await telegram.sendMessage(chatId, `没有这条路由：${arg}`);
          return true;
        }
        const chatKey = `tg:${chatId}`;
        const switched = await runtime.switchRoute(chatKey, wanted);
        if (switched.ok) {
          if (!useHostRoutes) activeRoute = wanted;
          await telegram.sendMessage(chatId, `✅ 已切到 ${wanted.key} — ${describeRoute(wanted)}`);
        } else {
          await telegram.sendMessage(chatId, `❌ 切换失败：${switched.error}`);
        }
        return true;
      }

      case '/new': {
        const chatKey = `tg:${chatId}`;
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

      case '/help':
        await telegram.sendMessage(
          chatId,
          [
            '可用命令：',
            '/new — 开新会话（并写 handoff）',
            '/model — 查看/切换模型',
            '/status — 查看插件状态',
            '/whoami — 查看你的用户 ID',
            '/help — 这条帮助',
          ].join('\n'),
        );
        return true;

      default:
        return false; // 不认识的命令 → 当普通消息交给模型
    }
  }

  // -------------------------------------------------------------------------
  // 微信长轮询
  // -------------------------------------------------------------------------
  let wxCursor = '';
  let wxAbort = null;

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

      // ⚠️ 即使 ret≠0 也要推进游标，否则后续调用一直用空 cursor 重试（BOT 注释原话）。
      if (batch.get_updates_buf) wxCursor = batch.get_updates_buf;
      // ret=-2 = 通道「伪过期」，清掉本地缓存等用户下一条消息带新 token 恢复。
      if (batch.ret === -2) {
        error('微信通道 ret=-2（伪过期），清除本地缓存，等用户下一条消息恢复');
        await weixin.reconnect().catch(() => {});
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

    // 新鲜 context_token 必存 —— 通道恢复靠的就是它（BOT 实证：notifystart 没用）。
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
        { command: 'status', description: '查看当前状态' },
        { command: 'whoami', description: '查看我的用户 ID' },
        { command: 'help', description: '显示帮助' },
      ])
      .catch((err) => error(`setMyCommands 失败: ${err.message}`));

    telegram
      .getMe()
      .then((info) => log(`Telegram 已登录：@${info.username} (${info.id})`))
      .catch((err) => error(`连不上 Telegram：${err.message}`));
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
  // 两个轮询并行跑；单个挂掉不影响另一个（微信没登录也必须让 TG 照跑）。
  Promise.all([pollLoop(), weixinPollLoop()]).catch((err) =>
    error(`轮询循环异常退出: ${err?.stack ?? err?.message}`),
  );

  // -------------------------------------------------------------------------
  // 卸载
  // -------------------------------------------------------------------------
  ctx.on('dispose', async () => {
    state.stopped = true;
    pollAbort?.abort();
    wxAbort?.abort();
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
export { markAsHubOutput, makeMessage, isRouteFailure, routeFor };

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
import { existsSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  memoryDir: Schema.string().description('记忆目录（每项目独占）。不填 = 默认 <工作目录>/memory；显式填空串 = 关闭记忆'),
  memoryScript: Schema.string().description('共享的 cache-manager.mjs 路径。不填 = 用插件自带的 vendor/conversation-cache/cache-manager.mjs'),
  restartCommand: Schema.string().description('重启用的启动器 .command 路径。不填 = 默认找 <工作目录>/启动-mybot.command；找不到且拿不到原始命令行时，/restart 退化为只重开会话'),

  // ---- 行为 ----
  backlogMaxAgeSeconds: Schema.number().default(2 * 60 * 60)
    .description('停机太久时，超过这个年龄的积压消息不再执行（默认 2 小时）'),
  turnTimeoutMs: Schema.number().default(30 * 60 * 1000)
    .description('等模型回答的超时（毫秒，默认 30 分钟）。超时后该会话的队列才会解锁'),
  logLabel: Schema.string().default('botplugin').description('日志前缀'),

  // ---- 语音转文字 ----
  // 这三个路径没有默认值：留空时收到语音会给「请设置 xxx」的可操作报错，而不是 ENOENT。
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
 * ⚠️ 一个 token 只能有一个进程 —— 第二个进程会让先启动的那个收 409，
 *    表现就像 bot 随机不理人。
 *    插件运行在宿主进程里，不能 process.exit 拖垮整个 DSH，
 *    所以这里只报错并停掉自己的轮询。
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

  // ── 宿主模型表：跟随 web 端「设置 → 模型」（settings.yaml），加减模型即时生效 ──
  //    key 规则：单模型 provider 用别名，多模型 `<别名>:<模型id>`。
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
          // 同上：deepseek 目录里 reasoningEffort 没配就是 'none' = 不发，交给模型默认。
          // 配了才发（bot 的 web 端 settings.yaml 里 llm-deepseek.reasoningEffort: off 是显式配置）。
          reasoningEffort: dsSection.reasoningEffort ?? 'none',
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

    // 冷启动记忆：会话还不存在（即将新建）= 上一段已随 /new、/restart、切模型
    // 或进程重启断开 —— 把 handoff 塞进第一条消息前面，模型不用用户复述上文。
    // 会话一旦存在 sessionIdOf 就非空，天然「每个会话只注一次」；
    // 记账在上一行已用原文落账，不受注入影响。
    let promptText = text;
    if (memory && runtime.sessionIdOf(chatKey) === null) {
      const boot = memory.readBootstrapContext();
      if (boot) {
        promptText = `<冷启动记忆（系统自动注入，无需回复此段）>\n${boot}\n</冷启动记忆>\n\n${text}`;
        log(`[mem] 已注入冷启动记忆（${chatKey}）`);
      }
    }

    // ① 先订阅，后发消息
    const waiting = runtime.waitForTurn(chatKey, config.turnTimeoutMs);

    // ② 发给 DSH
    const sent = await runtime.prompt(chatKey, promptText);
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
          error('   常见原因：同一个 token 有别的进程在用（例如另一个 bot 或另一份插件）。');
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
    // 图片块必须真的压进 blocks：只声明 inputModalities 是没用的。
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
   * 已实现的是插件自己就能完成的那几个；/restart 这类需要重启宿主进程的
   *    命令语义不同，留待后续。
   *
   * @returns {Promise<boolean>} true = 已处理（调用方不要再当普通消息发）
   */
  /**
   * 组装重启接力脚本的环境变量；无法安全拉起时返回 null（/restart 退化为只重开会话）。
   *
   * 两条拉起路径：
   *   ① 启动器（macOS 安装包用户）：配置 restartCommand 或 <工作目录>/启动-mybot.command，
   *      helper 用 `open` 重开一个新的终端窗口；
   *   ② 原始命令行：把本进程的 node + 脚本 + 参数原样交给 helper nohup 拉起（尽力而为，
   *      宿主原先是终端窗口的话，那个窗口会结束、bot 转后台）。
   */
  function restartPlanEnv() {
    const cwd = config.cwd || process.cwd();
    const launcher = config.restartCommand || join(cwd, '启动-mybot.command');
    const hasLauncher = Boolean(launcher) && existsSync(launcher);
    const [, scriptPath, ...extraArgs] = process.argv;
    if (!hasLauncher && !scriptPath) return null;
    return {
      RESTART_DELAY_SECONDS: '8',
      RESTART_TARGET_PID: String(process.pid),
      RESTART_LOG: join(cwd, 'dsh-restart.log'),
      ...(hasLauncher ? { RESTART_LAUNCHER: launcher } : {}),
      ...(scriptPath
        ? {
            RESTART_NODE: process.execPath,
            RESTART_SCRIPT: scriptPath,
            RESTART_ARGS: extraArgs.join(' '),
            RESTART_CWD: cwd,
          }
        : {}),
      ...(config.telegramToken ? { RESTART_TG_TOKEN: config.telegramToken } : {}),
    };
  }

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
        // 切模型 = 旧会话即将作废（换档重建），断开前先写 handoff —— 与老 bot 同口径：
        // 本次会话 ≥20 条才写，调试期间反复切模型不会覆盖已有记忆。
        if (memory) {
          memory.maybeWriteHandoff({
            sessionId: runtime.sessionIdOf(chatKey) ?? chatKey,
            reason: 'model',
            currentRoute: () => activeRoute,
            ownerUserId: state.ownerUserId,
            workspace: config.cwd || process.cwd(),
            sessionCreatedAt: sessionCreatedAt.get(chatKey) ?? 0,
          });
        }
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

      case '/restart': {
        const chatKey = `tg:${chatId}`;
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
          const child = spawn('/bin/bash', [helper], {
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

      case '/help':
        await telegram.sendMessage(
          chatId,
          [
            '可用命令：',
            '/new — 开新会话（并写 handoff）',
            '/restart — 重启进程加载新代码（先留档再重启）',
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

      // 即使 ret≠0 也要推进游标，否则后续调用一直用空 cursor 重试。
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
        { command: 'restart', description: '重开会话（自动留档）' },
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

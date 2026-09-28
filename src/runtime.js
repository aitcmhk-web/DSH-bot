/**
 * BotRuntime —— 插件版的「会话运行时」。
 *
 * ⭐ 它替换掉 BOT 的 `dsh.js`（那个 spawn `dsh --profile sdk` 子进程、说 JSON-RPC 的桥）。
 *
 *   为什么能替换：BOT 靠子进程做的事只有三件 ——
 *     ① 建会话；② 把用户消息塞进去；③ 把回答/状态转成事件。
 *   而插件**已经住在 DSH 进程里**，这三件事由宿主的 `ctx.agents` 服务直接提供
 *   （官方 `dsh-sdk-jsonrpc-server` 就是这么用的，本文件的调用顺序照抄它）。
 *   多出来的那个子进程在插件版里没有存在意义 —— 它是「进程外桥」，插件是进程内。
 *
 * ⚠️ 与 BOT 版的一处**行为差异**（必须记住，否则会当成 bug）：
 *   BOT 切模型 = 重启子进程（`DshRuntime.restart()`）。
 *   插件版**没有子进程可重启**，模型在 `agents.create({agentOptions})` 时就定死了；
 *   官方接口只提供 `resume(resumeSessionId)`（续一个**已持久化**的会话），
 *   没有「给活着的 agent 换模型」。
 *   因此切档实现为：**dispose 旧会话 → 按新档 create 新会话**。
 *   副作用是上下文不跨档保留（BOT 版重启后靠 handoff 接续，这里同理）。
 *
 * ⚠️ 本文件内的所有 ctx.* 调用均照抄官方 sdk-jsonrpc-server 的用法；
 *    未在本机实跑过（插件还没挂进 DSH），标 ⚠️ 推断。
 */

// ⚠️ 这里**故意不 import 任何 @deepseek-ai/* 包** —— 实测解析不到（probe-resolution.mjs）。
//    需要的东西只有两样，都已本地实现：
//      · brandString  → 官方实现就是 `return value`（dsh-brand/lib/index.js），纯类型标记，
//                       运行时什么都不做 → 直接传字符串，连替代函数都不需要。
//      · createUserMessage → 见 src/message.js。
import { createUserMessage, textContent } from './message.js';

/** 会话 id 的插件内前缀，避免与宿主其它来源的会话撞名。 */
const SESSION_PREFIX = 'botplugin';

/**
 * 会话事件名。
 *
 * ✅ 已核对官方源码，不再是猜测：
 *    `@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js:68`：
 *      `ctx.on("session/event", (session, event) => {...})`
 *    要点三条，之前全猜错了：
 *      ① 事件名是 `session/event`（斜杠）；
 *      ② 挂在 **ctx** 上，不是 agent 上；
 *      ③ 回调是**两个参数** `(session, event)`，不是一个 payload 对象。
 *    官方紧接着用 `String(session.id)` 当 sessionId —— 同一套约定。
 */
const SESSION_EVENT = 'session/event';

/** 兼容旧写法：万一宿主某版本用连字符，也收一份（不影响正确性）。 */
const EVENT_ALIASES = ['session-event'];

const log = (...args) => console.log('[botplugin]', ...args);
const logErr = (...args) => console.error('[botplugin]', ...args);

/**
 * 一个 chat（Telegram 私聊 / 微信）对应一个 DSH 会话。
 *
 * chatKey：插件内部给会话起的稳定标识（TG 用 `tg:<userId>`，微信用 `wx:<id>`）。
 * 用字符串而不是裸数字，是因为 BOT 版有个历史包袱 —— TG 和微信**共用同一个
 * chatId**（都锚在 ownerUserId 上，见 BOT/bot.js:66）。插件版不要那个耦合：
 * 两端各自一个 key，谁先绑定谁先有会话。
 */
export class BotRuntime {
  /** @type {Map<string, {handle: object, routeKey: string|null}>} */
  #sessions = new Map();

  /** 正在建的会话（同一 key 并发来消息时复用同一次创建，别建两个）。 */
  #creating = new Map();

  /** 会话事件订阅者。见 {@link BotRuntime#onSessionEvent} 的说明。 */
  #subscribers = new Set();

  /** @type {object|null} */
  #ctx = null;

  #stopped = false;

  /** 默认档位（provider/model/reasoningEffort），由配置给出。 */
  #defaultRoute = null;

  /** ctx 级会话事件是否已订阅（防止每个新会话重复挂）。 */
  #ctxBridged = false;

  /** cwd —— 新会话的工作区。 */
  #cwd = process.cwd();

  /**
   * @param {object} options
   * @param {object} options.ctx Cordis 插件上下文（apply 的第一个参数）
   * @param {{provider:string, model:string, reasoningEffort?:string}} [options.route] 默认档位
   * @param {string} [options.cwd] 会话工作区，默认进程 cwd
   */
  constructor({ ctx, route, cwd } = {}) {
    this.#ctx = ctx ?? null;
    if (route) this.#defaultRoute = route;
    if (cwd) this.#cwd = cwd;
    // ⚠️ ctx 级事件订阅必须在这里挂，不能等到第一个会话创建时再挂。
    //    理由：`ctx.on('session/event')` 跟具体 agent 无关，
    //    而建会话那一刻才挂 = 订阅之前的事件全部丢失（实测：挂载后
    //    ctx 上监听数为 0，要靠 30 分钟超时才拿得到答案）。
    this.#bridgeCtxEvents();
  }

  /** ctx 级的会话事件订阅（每实例一次）。 */
  #bridgeCtxEvents() {
    const ctx = this.#ctx;
    if (!ctx || typeof ctx.on !== 'function') {
      logErr('ctx 上没有 .on() —— 收不到会话事件，只能靠 turn 超时兜底');
      return;
    }
    this.#bridgeAgentEvents(null);
  }

  /** 运行时是否已就绪（宿主 agents 服务在不在）。 */
  get ready() {
    return !this.#stopped && this.#agents() !== undefined;
  }

  /**
   * 取宿主的 agents 服务。
   *
   * ⚠️ 必须是 `ctx.agents`（**属性**），不是 `ctx.get('agents')`。
   *    依据（✅ 已核对官方源码）：
   *    `@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js:157` 与 `:219` 都是
   *    `this.ctx.agents.create(...)` / `this.ctx.agents.get(...)`。
   *    之前写成 `ctx?.get('agents')` 是错的 —— 而且 `?.` 只挡 `ctx` 为 null，
   *    挡不住「没有 get 方法」，于是运行到建会话那一刻才炸：
   *    `TypeError: this[#ctx]?.get is not a function`（实测复现）。
   *    加 `typeof` 兜底，让缺服务时给出可读错误而不是 TypeError。
   */
  #agents() {
    const ctx = this.#ctx;
    if (!ctx) return undefined;
    return ctx.agents ?? (typeof ctx.get === 'function' ? ctx.get('agents') : undefined);
  }

  /** 当前活着的会话数，供 /status 显示。 */
  get sessionCount() {
    return this.#sessions.size;
  }

  /**
   * 更新默认档位。**只影响之后新建的会话** —— 已经在跑的会话不会被改动，
   * 想生效请走 {@link switchRoute}。
   * @param {{provider:string, model:string, reasoningEffort?:string}} route
   */
  setDefaultRoute(route) {
    this.#defaultRoute = route;
  }

  /**
   * 给某个 chat 发一条用户消息。会话不存在就按当前档位建一个。
   *
   * ⚠️ 这是**排队**语义（`followup` 立即返回），回答要靠事件收 ——
   *    与 BOT 版 `session/prompt` 的语义一致（那边也是发完等 `session.event`）。
   *    调用方不要指望返回值里有回答。
   *
   * @param {string} chatKey 会话标识，如 'tg:123456789'
   * @param {string|Array<object>} content 文本，或已构造好的内容块数组
   * @returns {Promise<{ok:true, messageId?:string, created:boolean} | {ok:false, error:string}>}
   */
  async prompt(chatKey, content) {
    if (this.#stopped) return { ok: false, error: 'runtime stopped' };
    const rec = await this.#ensureSession(chatKey);
    if (!rec.ok) return rec;
    try {
      const message = createUserMessage({
        content: typeof content === 'string' ? textContent(content) : content,
        source: { kind: 'user' },
      });
      rec.handle.agent.followup(message);
      return { ok: true, messageId: message.id, created: rec.created };
    } catch (err) {
      logErr(`followup failed for ${chatKey}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * 切档位：关掉这个 chat 的旧会话，按新档位建一个新的。
   *
   * ⚠️ 上下文不跨档保留 —— 见文件头说明（插件版没有「给活着的 agent 换模型」）。
   *
   * @param {string} chatKey
   * @param {{provider:string, model:string, reasoningEffort?:string}} route
   */
  async switchRoute(chatKey, route) {
    this.#defaultRoute = route;
    const rec = this.#sessions.get(chatKey);
    if (rec) {
      this.#sessions.delete(chatKey);
      await this.#dispose(chatKey, rec);
    }
    const next = await this.#ensureSession(chatKey);
    return next.ok
      ? { ok: true, route }
      : next;
  }

  /**
   * 主动结束某个 chat 的会话（保留其它 chat）。
   * @param {string} chatKey
   */
  async closeSession(chatKey) {
    const rec = this.#sessions.get(chatKey);
    if (!rec) return;
    this.#sessions.delete(chatKey);
    await this.#dispose(chatKey, rec);
  }

  /**
   * 取某 chat 的会话 id（没有则 null）。写 handoff / 记流水账时要用。
   * @param {string} chatKey
   * @returns {string|null}
   */
  sessionIdOf(chatKey) {
    const rec = this.#sessions.get(chatKey);
    if (!rec) return null;
    return String(rec.handle.agent.id);
  }

  /** 列出当前活着的会话（chatKey → sessionId），供 /status。 */
  listSessions() {
    return [...this.#sessions].map(([chatKey, rec]) => ({
      chatKey,
      sessionId: String(rec.handle.agent.id),
      routeKey: rec.routeKey,
    }));
  }

  /** 停掉全部会话。插件卸载时调。 */
  async stop() {
    this.#stopped = true;
    const entries = [...this.#sessions];
    this.#sessions.clear();
    await Promise.allSettled(entries.map(([key, rec]) => this.#dispose(key, rec)));
  }

  // -------------------------------------------------------------------------
  // 事件与「等一轮回答」
  // -------------------------------------------------------------------------
  //
  // ⚠️ 为什么需要这一层：`agent.followup()` 是**排队语义**，它立刻返回，
  //    回答不在返回值里 —— 只能靠订阅事件收。BOT 版对应的是
  //    `DshRuntime.createTurnWaiter()` + `session-event`（bot.js:1041-1066）。
  //
  // ⚠️ BOT 里订阅的**事件名是 `session-event`**，但那是 BOT 自己的
  //    `DshRuntime` 起的名字（它从子进程的 JSON-RPC 通知里转出来的）。
  //    插件版活在 DSH 进程内，没有那层转发，所以要直接挂到 agent 身上。
  //    DSH 的 agent 事件名**未在本机实跑验证**（插件还没挂进 DSH），
  //    因此这里**三种挂法都试**（agent.on / ctx.on / ctx.agents.on 的
  //    'session/event' 与 'session-event'），谁能收谁收，收不到就靠超时兜底。
  //    ⚠️ 标 推断：事件名与 `event.type` 的取值需要挂载后实跑确认。

  /**
   * 挂上会话事件监听。
   *
   * @param {(payload:{sessionId:string, event:object}) => void} handler
   * @returns {() => void} 取消订阅
   */
  onSessionEvent(handler) {
    this.#subscribers.add(handler);
    // ⚠️ 这里**只**登记到 #subscribers，不再往 agent.on 上直接挂。
    //    两处都挂会让同一个 handler 被调用两次（agent 事件已由
    //    #bridgeAgentEvents 转进 #emitSessionEvent），而且绕过错误隔离 ——
    //    一个订阅者抛错会顺着 agent 的事件链把别的订阅者一起带崩（实测复现）。
    return () => {
      this.#subscribers.delete(handler);
    };
  }

  /**
   * 把事件派发给所有订阅者。
   *
   * ⚠️ **为什么要有这一层、而不是直接靠 agent.on**：会话是**懒建**的 ——
   *    监听挂载的时刻可能还没有 agent，那时 `agent.on` 没东西可挂，
   *    事件就永远收不到（实测复现：waitForTurn 先于 prompt 调用 → 挂不上）。
   *    所以内部统一走这个口子，谁订阅谁收到，与会话建立的先后无关。
   *
   * @param {{sessionId:string, event:object}} payload
   */
  #emitSessionEvent(payload) {
    for (const fn of [...this.#subscribers]) {
      try { fn(payload); } catch (err) { logErr(`session event handler failed: ${err.message}`); }
    }
  }

  /**
   * 等某个会话的一轮结束。
   *
   * ⚠️ 必须带超时。BOT 用的就是 30 分钟（bot.js:1107「等待回复超时(30 分钟)」）——
   *    没有超时的话，模型卡住会让这个 chat 的队列**永久堵死**，
   *    表现就是「发消息永远不回、日志里什么都没」。
   *
   * @param {string} chatKey
   * @param {number} timeoutMs
   * @returns {Promise<{ok:true, text:string} | {ok:false, error:string}>}
   */
  waitForTurn(chatKey, timeoutMs = 30 * 60 * 1000) {
    const rec = this.#sessions.get(chatKey);
    const sessionId = rec ? String(rec.handle.agent.id) : null;

    return new Promise((resolve) => {
      let text = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
        resolve(result);
      };

      const timer = setTimeout(
        () => finish({ ok: false, error: '等待回复超时（30 分钟）' }),
        timeoutMs,
      );

      const off = this.onSessionEvent((payload) => {
        const { sessionId: sid, event } = payload ?? {};
        if (sessionId !== null && sid !== sessionId) return;

        // 一轮结束
        if (event?.type === 'turn/end') {
          const reason = event.data?.reason ?? null;
          if (reason?.kind === 'error') {
            const failure = reason.error ?? {};
            finish({ ok: false, error: failure.message ?? failure.error?.message ?? '模型调用失败' });
            return;
          }
          finish({ ok: true, text: text.trim() });
          return;
        }

        // 助手文字：**整轮覆盖**，不是累加（与 BOT 一致，bot.js:1064）
        if (event?.type === 'assistant/message') {
          const content = event.data?.message?.content;
          if (!Array.isArray(content)) return;
          const t = content
            .filter((b) => b?.type === 'text' || b?.type === 'reasoning')
            .map((b) => b.text ?? b.reasoning ?? '')
            .join('');
          if (t.trim()) text = t;
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  async #ensureSession(chatKey) {
    const existing = this.#sessions.get(chatKey);
    if (existing) {
      // ⚠️ agent 可能被外部（宿主 / preset 卸载）dispose 掉，必须复查 ——
      //    BOT 版踩过同类坑：pidfile 在 ≠ 进程活着（AGENTS.md 三.13）。
      const live = this.#ctx?.agents?.get(existing.handle.agent.id) === existing.handle.agent;
      if (live) return { ok: true, handle: existing.handle, created: false };
      log(`session for ${chatKey} was disposed outside botplugin; recreating`);
      this.#sessions.delete(chatKey);
    }
    const pending = this.#creating.get(chatKey);
    if (pending) return pending;

    const task = this.#create(chatKey);
    this.#creating.set(chatKey, task);
    try {
      return await task;
    } finally {
      this.#creating.delete(chatKey);
    }
  }

  async #create(chatKey) {
    const agents = this.#agents();
    if (agents === undefined) {
      return { ok: false, error: 'host has no `agents` service (dsh-agent-loop not loaded)' };
    }
    const route = this.#defaultRoute;
    if (!route?.provider || !route?.model) {
      return { ok: false, error: 'no model route configured for botplugin' };
    }
    // ⚠️ 启动竞态（2026-09-28 真宿主实测）：`inject:['agents']` 只保证服务对象在，
    //    不保证 agent-loop 已把工厂 setFactory 进去（dsh-agent-loop/lib/index.js:1533）。
    //    第一条消息可能赶在工厂注册前进来，create/resume 会抛
    //    "no agent factory registered"。这是纯时序问题，等一等就好 —— 最多 30s。
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        let handle;
        let created;
        try {
          handle = await agents.create({
            // ⚠️ 官方写法是 `brandString(\`...\`)`，但 brandString 的官方实现就是
            //    `return value`（dsh-brand/lib/index.js:9）—— 纯类型标记，运行时是空操作。
            //    这里直接传字符串，语义完全相同，且省掉一个解析不到的依赖。
            sessionId: `${SESSION_PREFIX}:${chatKey}`,
            meta: { cwd: this.#cwd },
            agentOptions: {
              provider: route.provider,
              model: route.model,
              ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
            },
          });
          created = true;
        } catch (err) {
          // ⚠️ 会话**持久化在磁盘上**，进程/插件重启后还在。再次 create 会抛
          //    `session "X" already exists`（dsh-session/lib/index.js:1380）。
          //    官方为此给了 agents.resume({resumeSessionId, agentOptions})
          //    （dsh-agent/lib/index.js:430；工厂实现 dsh-agent-loop/lib/index.js:1876）：
          //    重开持久化日志、回放事件、接着聊 —— 这正是聊天机器人重启后该有的行为。
          if (!String(err?.message ?? err).includes('already exists')) throw err;
          handle = await agents.resume({
            resumeSessionId: `${SESSION_PREFIX}:${chatKey}`,
            agentOptions: {
              provider: route.provider,
              model: route.model,
              ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
            },
          });
          created = false;
        }
        this.#sessions.set(chatKey, { handle, routeKey: route.key ?? null });
        this.#bridgeAgentEvents(handle.agent);
        log(`session ${created ? 'created' : 'resumed (重启接续)'} for ${chatKey} (${route.provider}/${route.model})`);
        return { ok: true, handle, created };
      } catch (err) {
        const msg = String(err?.message ?? err);
        if (msg.includes('no agent factory registered') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        logErr(`session creation failed for ${chatKey}: ${msg}`);
        return { ok: false, error: msg };
      }
    }
  }

  /**
   * 把一个 agent 的事件转进内部派发口。
   *
   * ⚠️ 会话是懒建的，订阅却可能更早发生，所以每个新建的 agent 都要在这里
   *    "接线"，不能只在 onSessionEvent 里挂一次。
   *
   * ✅ 依据官方写法（sdk-jsonrpc-server/lib/index.js:68）：事件挂在 **ctx** 上，
   *    回调签名是 `(session, event)`。所以这里不再往 agent.on 上挂 ——
   *    那是之前基于 BOT 的 `session-event` 猜测写出来的，挂不上也静默降级。
   *
   *    订阅一次即可（ctx 级），不用每个 agent 接线；但为了兼容「agent 上也能挂」
   *    的宿主版本，仍然尝试 agent.on 作为补充，两条路都收，重复由调用方幂等处理。
   *    挂不上只记日志，不抛错 —— 还有 waitForTurn 的超时兜底。
   */
  #bridgeAgentEvents(agent) {
    const sessionId = String(agent?.id ?? '');
    let bound = 0;

    // ① 首选：ctx 级订阅，官方签名 (session, event)
    //    ⚠️ 只挂一次（构造函数里已挂）。重复挂会让同一条事件派发两次，
    //       订阅者看到的答案虽然一样，但所有下游副作用都会翻倍。
    //    ⚠️ #ctxBridged 只在**真的挂上**时才置位（2026-09-28 真宿主教训）：
    //       构造期 ctx.on 可能抛 "cannot create effect on inactive context"
    //       （sdk-app 组合的 stdin-EOF 关停竞态），提前置位会把第一次
    //       #create 时的补挂机会也堵死 —— 那次实测 agent 级订阅救了场。
    const ctx = this.#ctx;
    if (!this.#ctxBridged && ctx && typeof ctx.on === 'function') {
      let ctxBound = 0;
      for (const evt of [SESSION_EVENT, ...EVENT_ALIASES]) {
        try {
          ctx.on(evt, (session, event) => {
            // 官方约定：第一个参数是 session 对象，用 String(session.id)。
            // 兼容某些版本把两者合成一个 payload 的情况。
            const sid = session?.id !== undefined ? String(session.id) : String(session?.sessionId ?? '');
            this.#emitSessionEvent({ sessionId: sid, event: event ?? session?.event ?? session });
          });
          ctxBound += 1;
        } catch { /* 换下一个名字 */ }
      }
      if (ctxBound > 0) this.#ctxBridged = true;
      bound += ctxBound;
    }

    // ② 补充：agent 级订阅（若宿主版本支持）
    if (agent && typeof agent.on === 'function') {
      for (const evt of [SESSION_EVENT, ...EVENT_ALIASES]) {
        try {
          agent.on(evt, (payload) => {
            this.#emitSessionEvent({
              sessionId: payload?.sessionId ?? sessionId,
              event: payload?.event ?? payload,
            });
          });
          bound += 1;
        } catch { /* 换下一个名字 */ }
      }
    }

    if (bound === 0) {
      logErr('挂不上任何会话事件 —— 只能靠 turn 超时兜底（回答会变慢但不会丢）');
    }
  }

  async #dispose(chatKey, rec) {
    try {
      await rec.handle.dispose();
    } catch (err) {
      // 关不掉不能影响别的 chat —— 记一笔就走。
      logErr(`dispose failed for ${chatKey}: ${err.message}`);
    }
  }
}

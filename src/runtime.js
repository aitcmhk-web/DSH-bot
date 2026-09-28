/**
 * BotRuntime —— 会话运行时。
 *
 * 建会话、投递用户消息、把回答转成事件，全部通过宿主的 `ctx.agents` 服务完成
 * （调用顺序与官方 dsh-sdk-jsonrpc-server 一致）。
 *
 * 切模型：模型在 agents.create({agentOptions}) 时定死，宿主接口只提供
 * resume(resumeSessionId) 续已持久化的会话，没有「给活着的 agent 换模型」，
 * 因此切档 = dispose 旧会话 → 按新档建新会话；上下文不跨档保留，
 * 由 handoff 记忆负责衔接。
 */

// 故意不 import 任何 @deepseek-ai/* 包；需要的东西都已本地实现：
//   · brandString → 官方实现就是 return value（纯类型标记），直接传字符串即可。
//   · createUserMessage → 见 src/message.js。
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
 * 两端各自一个 key，互不耦合；谁先绑定谁先有会话。
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
    // ctx 级事件订阅必须在构造时就挂上：ctx.on('session/event') 跟具体 agent
    //    无关，等到建会话才挂会丢掉之前的事件。
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
   *    加 typeof 兜底，缺服务时给出可读错误而不是 TypeError。
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
   * 这是排队语义（followup 立即返回），回答靠事件收，不在返回值里。
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
  // agent.followup() 是排队语义，回答只能靠订阅事件收。
  //    不同宿主版本的事件挂点与命名略有差异，所以三种挂法都试
  //    （agent.on / ctx.on / ctx.agents.on 的 'session/event' 与 'session-event'），
  //    谁能收谁收，收不到就靠超时兜底。

  /**
   * 挂上会话事件监听。
   *
   * @param {(payload:{sessionId:string, event:object}) => void} handler
   * @returns {() => void} 取消订阅
   */
  onSessionEvent(handler) {
    this.#subscribers.add(handler);
    // 只登记到 #subscribers，不往 agent.on 上重复挂：两处都挂同一个 handler
    //    会被调两次，还绕过错误隔离（一个订阅者抛错会带崩事件链上的其他订阅者）。
    return () => {
      this.#subscribers.delete(handler);
    };
  }

  /**
   * 把事件派发给所有订阅者。
   *
   * 会话是懒建的：监听挂载时可能还没有 agent，直接挂 agent.on 会收不到事件。
   *    统一走这个口子，谁订阅谁收到，与会话建立的先后无关。
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
   * 必须带超时（30 分钟）：模型卡住时没有超时会让这个 chat 的队列永久堵死，
   *    表现就是发消息永远不回、日志里什么都没有。
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

        // 助手文字按整轮覆盖，不是累加
        if (event?.type === 'assistant/message') {
          const content = event.data?.message?.content;
          if (!Array.isArray(content)) return;
          // 只取正文：reasoning（思考过程）不进正文 —— 否则会一起发到 TG、
          // 并记进流水账/handoff，用户看到的就是"小作文"。
          const t = content
            .filter((b) => b?.type === 'text')
            .map((b) => b.text ?? '')
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
      // agent 可能被宿主外部 dispose，必须复查它还活着
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
    // 启动时序：inject:['agents'] 只保证服务对象在，不保证 agent 工厂已注册。
    //    第一条消息可能赶在工厂注册前进来，create/resume 会抛
    //    "no agent factory registered" —— 纯时序问题，等一等就好（最多 30s）。
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
   * 官方写法（sdk-jsonrpc-server/lib/index.js:68）：事件挂在 ctx 上，
   *    回调签名是 (session, event)。为了兼容「agent 上也能挂」的宿主版本，
   *    仍尝试 agent.on 作为补充，两条路都收，重复由调用方幂等处理。
   *    挂不上只记日志，不抛错 —— 还有 waitForTurn 的超时兜底。
   */
  #bridgeAgentEvents(agent) {
    const sessionId = String(agent?.id ?? '');
    let bound = 0;

    // ① 首选：ctx 级订阅，官方签名 (session, event)
    //    只挂一次（构造函数里已挂），重复挂会让同一条事件派发两次。
    //    #ctxBridged 只在真的挂上时才置位：构造期 ctx.on 可能抛
    //    "cannot create effect on inactive context"（宿主正在关停），
    //    提前置位会堵死 #create 时的补挂机会。
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

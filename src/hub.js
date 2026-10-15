/**
 * 节点（hub）—— 所有端点的唯一交汇点。零依赖纯逻辑。
 *
 * 架构：
 *
 *   入站：TG ─┐
 *       微信 ─┼─→ [节点] ─┬─→ DSH
 *       第N ─┘            └─→ 其他所有端点
 *
 *   出站：DSH ─→ [节点] ─→ 所有端点
 *
 * 两条规则，都是「同步到所有」：
 *   1. 端点到节点 → 这条同步给 ① DSH ② 其他所有端点
 *   2. DSH 到节点 → 这条同步发到所有端点
 *
 * ⛔ 不要在这里加「去重」「合并」「判断是不是同一条」——
 *    进来几条就是几条，是两次真实输入。节点不判断，收到就转发。
 *
 * ⛔ 不要再写成对镜像（mirrorTgToWeixin / mirrorWxToTelegram 那种）——
 *    那是 O(n²)：加 N 个端点要写 2N 条。这里是 O(n)：加端点 = 加一个数组项。
 *
 * 端点只管自己的协议：怎么收、怎么发、怎么渲染。
 * 节点不管协议，只管「归一 → 广播」。
 */

/** 一条归一消息。所有端点进出都长这样，与具体协议无关。 */
export function makeMessage({
  source,        // 端点 id：'tg' | 'wx' | ...
  chatId,        // 该端点上的会话/发送者 id（端点自己解释）
  text,          // 纯文本正文
  media = null,  // 媒体（语音/图片已由端点预处理成 text 的，此处为 null）
  raw = null,    // 端点原始消息（供端点自己回查，节点不碰）
  viaHub = false, // ⚠️ 关键：true = 这条是本系统广播出去的，不是新的入站输入
}) {
  return { source, chatId, text, media, raw, viaHub, at: Date.now() };
}

/**
 * 回流防护标记。
 *
 * 广播到端点后，那条消息不能又被端点当成新输入送回节点（否则死循环）。
 *
 * ⚠️ 用**结构标记**，不是文本前缀。
 *    现在代码里靠 `📱[WX] ` / `📱[TG] [电报] ` 前缀防循环 —— 那是错的：
 *      - 加第 N 个端点就要再发明一套前缀（又是 O(n) 的字符串约定）
 *      - 入站消息真的以 `📱[WX] ` 开头时会被误判
 *    结构标记由**发送方在消息对象上**携带，端点侧判断，不污染正文。
 *
 * 见 `施工说明书.md:148`：「防循环不靠文本前缀，靠"这条是本系统产生的"结构标记」。
 */
export const HUB_MARK = Symbol.for('dsh.bot.hub.origin');

/** 给一条出站消息打上「本系统产出」标记。 */
export function markAsHubOutput(msg) {
  Object.defineProperty(msg, HUB_MARK, { value: true, enumerable: false });
  return msg;
}

/** 这条消息是不是本系统广播出去的？（是 → 端点不得当新输入处理） */
export function isHubOutput(msg) {
  return Boolean(msg && msg[HUB_MARK]);
}

/**
 * 节点。持有端点列表，负责广播。
 *
 * 用法：
 *   const hub = new Hub({ onInbound: (msg) => dsh.prompt(msg) })
 *   hub.add(tgEndpoint)
 *   hub.add(wxEndpoint)
 *   hub.start()   // 各端点开始接收
 */
export class Hub {
  /** @param {{ onInbound?: (msg) => any, log?: (line: string) => void }} opts */
  /**
   * @param {object} opts
   * @param {(msg:object)=>any} [opts.onInbound]
   * @param {(line:string)=>void} [opts.log]
   * @param {(notice:{failed:Array<{id:string,error:string}>, label:string, sent:string[]})=>any} [opts.onDeliveryFailure]
   *   投递失败时回调（成功不调）。当前调用方不传 → 完全不触发，钩子为将来复用保留。
   *   若重新启用：必须「失败才叫」，每条回答都回执会把聊天刷爆。
   */
  constructor({ onInbound = null, log = null, onDeliveryFailure = null } = {}) {
    /** @type {Map<string, object>} id → 端点适配器 */
    this.endpoints = new Map();
    this.onInbound = onInbound;
    this.log = log ?? ((line) => console.log(line));
    this.onDeliveryFailure = onDeliveryFailure;
    /**
     * 同一端点的告警去重：id → 上次告警时间。
     * 为什么要去重：微信通道挂掉时是**每条**回答都失败，不去重会变成刷屏告警，
     * 比不告警还烦。同一端点在窗口内只提醒一次，恢复后再挂会重新提醒。
     * 当前没有调用方传入 onDeliveryFailure，这套去重暂处休眠状态。
     */
    this.failureNotifiedAt = new Map();
    /** 静默窗口（毫秒）。窗口内同端点重复失败不重复告警。 */
    this.failureNoticeWindowMs = 10 * 60 * 1000;
  }

  /** 注册一个端点。适配器须实现 `id`，以及 send(msg) / start(handler)。 */
  add(endpoint) {
    if (!endpoint?.id) throw new Error('端点必须有 id');
    if (this.endpoints.has(endpoint.id)) {
      throw new Error(`端点 id 重复: ${endpoint.id}`);
    }
    this.endpoints.set(endpoint.id, endpoint);
    return this;
  }

  get(id) {
    return this.endpoints.get(id);
  }

  ids() {
    return [...this.endpoints.keys()];
  }

  /** 除 who 之外的所有端点。广播时用。 */
  others(who) {
    return [...this.endpoints.values()].filter((e) => e.id !== who);
  }

  /**
   * 端点 → 节点。
   *
   * 一条进来，同步给 ① 其他所有端点（镜像）② DSH。
   * ⛔ 不去重、不合并、不判断。进来几条就是几条。
   *
   * 端点适配器收到入站消息后调这个。
   */
  async inbound(msg) {
    // 回流防护：端点自己广播出去的消息若被误当输入，直接丢弃。
    if (msg.viaHub || isHubOutput(msg)) {
      this.log(`[hub] 丢弃回流消息（source=${msg.source}）`);
      return;
    }

    this.log(`[hub] 入站 ← ${msg.source}:${msg.chatId} (${String(msg.text).slice(0, 40)}…)`);

    // ① 先镜像给其他所有端点
    //
    // ⛔ 顺序不能反：DSH 的回答是在 onInbound 里跑完才产生的，
    //    先 await onInbound 的话镜像只能排在回答后面 —— 别人的微信里就成了
    //    「回答在上面、问话在下面」。broadcast 内部每个端点各自 try/catch、
    //    只把失败记进 failed 不往外抛，所以放前面不会卡住 DSH。
    await this.broadcast(msg, { exclude: msg.source, label: `${msg.source} 入站` });

    // ② 再交给 DSH
    if (this.onInbound) {
      try {
        await this.onInbound(msg);
      } catch (err) {
        console.error(`[hub] onInbound 失败: ${err.stack ?? err.message}`);
      }
    }
  }

  /**
   * DSH → 节点 → 所有端点。
   *
   * 一条输出，同步发到**所有**端点（不排除任何）。
   */
  async outbound(text, { exclude = null, label = 'DSH 输出' } = {}) {
    const msg = markAsHubOutput(makeMessage({
      source: 'hub',
      chatId: null,
      text,
      viaHub: true,
    }));
    return this.broadcast(msg, { exclude, label });
  }

  /**
   * 广播一条消息到端点们。
   *
   * ⚠️ exclude 只用于「端点 → 节点」那一半（不把消息原样发回给发信人自己）。
   *    「DSH → 节点」那一半**不排除任何端点**（输出要发到所有端点）。
   */
  async broadcast(msg, { exclude = null, label = '广播' } = {}) {
    const targets = [...this.endpoints.values()].filter((e) => e.id !== exclude);
    if (targets.length === 0) return { sent: [], failed: [] };

    const sent = [];
    const failed = [];

    // 并行发，且**单点失败不影响其他端点**（很重要：微信坏了不能拖垮 TG）。
    await Promise.all(targets.map(async (ep) => {
      try {
        await ep.send(msg);
        sent.push(ep.id);
      } catch (err) {
        failed.push({ id: ep.id, error: err.message });
        // ⚠️ 必须留痕。失败只打 first-failure 日志时，
        //    「消息没送到」在日志里完全看不出来，排查无从下手。
        console.error(`[hub] ${label} → ${ep.id} 失败: ${err.message}`);
      }
    }));

    // 无论成功失败都留痕，方便排查“端点没收到”的问题。
    this.log(`[hub] ${label}: 成功 [${sent.join(',')}] 失败 [${failed.map((f) => f.id).join(',')}]`);

    // ③ 失败 → 主动告警（成功不告警）：广播失败只写日志时，
    //    消息没送到却看起来一切正常，必须主动提醒。
    //    这是纯粹的**可观测性**补丁，不改变任何投递行为。
    //    ⚠️ 告警本身**绝不能**再抛错/再广播（否则失败会自激循环）：
    //       回调由调用方实现，这里 try/catch 全部吞掉。
    if (failed.length > 0 && typeof this.onDeliveryFailure === 'function') {
      const fresh = failed.filter((f) => {
        const last = this.failureNotifiedAt.get(f.id) ?? 0;
        return Date.now() - last >= this.failureNoticeWindowMs;
      });
      if (fresh.length > 0) {
        for (const f of fresh) this.failureNotifiedAt.set(f.id, Date.now());
        try {
          await this.onDeliveryFailure({ failed: fresh, label, sent });
        } catch (err) {
          console.error(`[hub] 投递失败告警本身也失败了(已忽略): ${err.message}`);
        }
      }
    }
    return { sent, failed };
  }

  /**
   * 启动所有端点。每个端点自己负责轮询/监听，收到消息就调 hub.inbound()。
   * 单个端点启动失败不影响其他（微信没登录也必须让 TG 照跑）。
   */
  async start() {
    const results = await Promise.all([...this.endpoints.values()].map(async (ep) => {
      if (typeof ep.start !== 'function') return { id: ep.id, skipped: true };
      try {
        await ep.start((msg) => this.inbound(msg));
        return { id: ep.id, ok: true };
      } catch (err) {
        console.error(`[hub] 端点 ${ep.id} 启动失败: ${err.message}`);
        return { id: ep.id, ok: false, error: err.message };
      }
    }));
    return results;
  }

  /** 停止所有端点。 */
  async stop() {
    await Promise.all([...this.endpoints.values()].map(async (ep) => {
      if (typeof ep.stop !== 'function') return;
      try {
        await ep.stop();
      } catch (err) {
        console.error(`[hub] 端点 ${ep.id} 停止失败: ${err.message}`);
      }
    }));
  }
}

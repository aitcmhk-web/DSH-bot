/**
 * approval-bridge — 把 DSH 的审批请求桥接到 Telegram（内联按钮）。
 *
 * 背景：DSH 的审批服务用 waterfall 广播 `approval/request`：
 *
 *   ctx.waterfall(scopeTarget(agent, agent), 'approval/request', request,
 *                 () => 'unavailable');
 *
 * 每个监听者收到 `(request, next)`：
 *   - 不处理 → `return next()`（把决定权交给下一个应答者 / 内建兜底）；
 *   - 处理   → 返回 Promise，resolve 成 `'allowed-once' | 'rejected' | 'cancelled'`。
 *
 * 合法返回值**只有**这三个（外加兜底的 `'unavailable'` = 没人应答 → 失败关闭）。
 * 所以本模块的原则是「宁可拒绝，绝不误放」：任何不确定/异常都走
 * `'cancelled'`（已经接手之后）或 `next()`（还没接手之前）。
 *
 * ⚠️ 作用域：`approval/request` 是 **agent 作用域事件**。dsh-scope 的
 *    `scopeTarget()` 过滤器只放行「同 scope / 上层 scope / **无 scope 标签**」
 *    的监听者（见 dsh-scope/lib/index.js:327 — `if (tag === void 0) return true`）。
 *    插件根 ctx 通常没有 scope 标签，因此能收到；但万一插件被挂在某个
 *    不相关的 scope 下就会漏掉。为此这里在 `ctx` 之外**再挂一份到
 *    `ctx.root`**（根 ctx 必然无标签，必然收得到），并用 WeakSet 去重，
 *    保证同一 request 只处理一次。
 *
 * 卡片正文**严格对齐 web 端审批面板**（`dsh-client-ui-approval/lib/client.js:96`
 * 的 `<strip> + <headline> + <command>` 三段），不加标签、不加时间戳：
 *
 *   第 1 行       等待审批 / 已允许 / 已拒绝 / 已取消 / 已超时   ← strip
 *   第 2 行       headline                                    ← 原因，缺则回退 escalation
 *   第 3 行起     command（完整原文，绝不截断）                  ← command 块，取不到则整块不出现
 *
 * @module approval-bridge
 */

import { randomBytes } from 'node:crypto';
import { splitMessage } from './telegram.js';

/** callback_data 上限（Telegram 硬限制 64 字节）。
 *  这里 id 固定 8 字符，`appr:ok:` 前缀 8 字符 → 16 字节，远低于上限。 */
const OK_PREFIX = 'appr:ok:';
const NO_PREFIX = 'appr:no:';
/** 默认超时：10 分钟。 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** 第 1 行（strip）的等待态文案，与 web 端 `t("waiting")` 一致。 */
const WAITING = '等待审批';

/** 短随机 id：6 字节 → 8 个 base64url 字符，`appr:ok:` + id 远小于 64 字节。 */
function makeId(taken) {
  for (let i = 0; i < 8; i += 1) {
    const id = randomBytes(6).toString('base64url');
    if (!taken.has(id)) return id;
  }
  // 8 次都撞（现实中不可能）→ 退回时间戳，仍保证短于上限。
  return Date.now().toString(36);
}

/**
 * 把 displayReason 归一成一行可读文本 —— 对应 web 端 `locale.resolveText()`。
 *
 * ⚠️ 它**不一定是字符串**：沙箱升级场景（dsh-sandbox/lib/index.js:110）给的是
 *    本地化对象 `{ en, zh }`，直接 String() 会渲染成 "[object Object]"。
 *    优先中文，再英文，再退回收字符串。
 *
 * @param {unknown} value
 * @returns {string|null} 空 / 取不到 → null
 */
export function normalizeReason(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object') {
    const zh = value.zh ?? value['zh-CN'] ?? value['zh-cn'];
    if (typeof zh === 'string' && zh.trim()) return zh.trim();
    const en = value.en;
    if (typeof en === 'string' && en.trim()) return en.trim();
    // 未知形状：把值摊平成 "k: v; k: v"，总比 [object Object] 强
    const flat = Object.entries(value)
      .filter(([, v]) => typeof v === 'string' && v.trim())
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ');
    if (flat) return flat;
    return null;
  }
  return String(value);
}

/* ------------------------------------------------------------------ *
 * command 块 —— 用 callId 从 agent 会话事件流里反查工具参数
 *
 * approval/request 载荷**不含参数**（dsh-user-approval/lib/types/index.d.ts:65
 * 明确写着“`callId` links to an already presented tool call, so arguments are
 * not duplicated here”），参数只存在于同一 session 的 `tool/call` 事件里：
 *
 *   dsh-agent-loop/lib/index.js:682
 *     session.append("tool/call", { turn, step, callId: block.id,
 *                                   name: block.name, arguments: block.arguments })
 *   dsh-session/lib/types/types.d.ts:354
 *     'tool/call': { turn; step; callId; name; arguments: string }  // 原始 JSON 字符串
 *
 * 读取方式照抄 dsh-user-approval/lib/index.js:49 `hasOpenTurn()`：
 *   session.eventAt(seq)（实现见 dsh-session/lib/index.js:1323 —— `this.log[seq]`），
 *   seq 从 `session.seq - 1` 往回走，撞到 `turn/start` 停（审批必然发生在
 *   已开启的回合内，所以工具调用不会早于本回合的 turn/start）。
 * session 的取得方式见 dsh-acp/lib/index.js:775 `this.agent.session.id`
 * → 即 `request.agent.session`。
 *
 * ⚠️ 这一整段是**尽力而为**：任何一步失败都返回 null，卡片静默省略该块，
 *    绝不抛错、绝不影响审批结果（按钮 / 超时 / abort / 失败关闭都不碰）。
 * ------------------------------------------------------------------ */

/**
 * 解析 tool/call 的 arguments。
 *
 * 正常路径是**原始 JSON 字符串**（模型产出、未解析），但别处也可能给对象，
 * 两种都收；解析失败返回 null。
 */
function parseArguments(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return Array.isArray(raw) ? null : raw;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 按 callId 反查 tool/call 事件的 `arguments`。
 *
 * @param {object} request approval/request 载荷
 * @returns {unknown} 参数字段（通常是 JSON 字符串），找不到返回 null
 */
function lookupCallArguments(request) {
  try {
    const callId = request?.callId;
    if (typeof callId !== 'string' || callId === '') return null;
    const session = request?.agent?.session;
    if (session === null || typeof session !== 'object') return null;
    if (typeof session.eventAt !== 'function') return null;
    const end = session.seq;
    if (!Number.isSafeInteger(end) || end <= 0) return null;
    // 从最新事件往回扫；撞到本回合的 turn/start 就停（工具调用必在其后）。
    for (let seq = end - 1; seq >= 0; seq -= 1) {
      let event;
      try {
        event = session.eventAt(seq);
      } catch {
        return null;
      }
      if (event === null || typeof event !== 'object') continue;
      if (event.type === 'tool/call') {
        const data = event.data;
        if (data !== null && typeof data === 'object' && data.callId === callId) {
          return data.arguments ?? null;
        }
        continue;
      }
      if (event.type === 'turn/start') return null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * command 块内容 —— 对应 web 端 `dsh-client-ui-chat/lib/client.js:12408`
 * 注册到 `conversation.approval.detail` 的 `ApprovalCommand`：
 *
 *   function commandOf(call) {
 *     if (call === undefined) return undefined;
 *     try {
 *       const args = JSON.parse(call.argsRaw);
 *       return typeof args.command === "string" ? args.command : undefined;
 *     } catch { return; }
 *   }
 *
 * 逐字对照：
 *   - 只有 `arguments.command` 是**字符串**才算数（数字 / 数组 / 缺字段 → 无）；
 *   - 不做任何工具名判断（web 也不判断，文件工具的参数里没有 `command` 自然为空）；
 *   - 返回**完整原文**：不 trim、不截断、不折行（多行原样保留换行）。
 *
 * @param {object} request approval/request 载荷
 * @returns {string|null} 无 command 块 → null（调用方静默省略整块）
 */
function commandOf(request) {
  try {
    const args = parseArguments(lookupCallArguments(request));
    if (args === null) return null;
    const command = args.command;
    return typeof command === 'string' ? command : null;
  } catch {
    // 软着陆：command 只是补充信息，绝不因此影响审批。
    return null;
  }
}

/**
 * headline —— 与 web 端完全相同的解析规则（client.js:43）：
 *
 *   reason = approval.displayReason === undefined ? approval.reason
 *                                                : resolveReason(approval.displayReason)
 *   headline = reason ?? t("escalation", { toolName })
 *            = 「工具 {toolName} 请求越权执行」
 *
 * @param {object} request approval/request 载荷
 * @returns {string}
 */
function headlineOf(request) {
  const source = request?.displayReason === undefined
    ? request?.reason
    : request?.displayReason;
  const reason = normalizeReason(source);
  if (reason) return reason;
  const toolName = request?.toolName === null || request?.toolName === undefined
    ? ''
    : String(request.toolName);
  return `工具 ${toolName} 请求越权执行`;
}

/**
 * 组装卡片正文（三段结构，与 web 面板一一对应）。
 *
 * @param {object} request approval/request 载荷
 * @param {string} status  第 1 行（strip）：等待审批 / 已允许 / 已拒绝 / 已取消 / 已超时
 * @param {string|null} [note] 附加说明（分多条时标注完整内容位置），可为空
 */
function cardText(request, status, note = null) {
  const lines = [status, headlineOf(request)];
  // command 块：仅当 `arguments.command` 是字符串才出现，完整原文、不截断。
  const command = commandOf(request);
  if (command !== null) lines.push(command);
  if (note) lines.push(note);
  return lines.join('\n');
}

/**
 * 安装审批桥。
 *
 * @param {object}   deps
 * @param {object}   deps.ctx       插件上下文（会挂 approval/request 监听）
 * @param {object}   deps.telegram  Telegram 客户端实例（不可用 → 完全不接管）
 * @param {() => (string|number|null)} deps.getChatId 卡片目标会话 id（#39：协作群优先、表头缺群 id 时回主人私聊），拿不到返回 null
 * @param {(msg: string) => void} [deps.log]
 * @param {(msg: string) => void} [deps.error]
 * @param {number}   [deps.timeoutMs] 审批超时，默认 10 分钟
 * @returns {{ handleApprovalCallback: (data: string, query: object) => boolean, dispose: () => void }}
 */
export function installApprovalBridge({
  ctx,
  telegram,
  getChatId,
  log = () => {},
  error = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  /** id → { request, chatId, messageId, parts, resolve, timer, signal, onAbort } */
  const pending = new Map();
  /** 已接手的 request 对象：防止 ctx / ctx.root 双注册各发一张卡。 */
  const claimed = new WeakSet();
  const offs = [];
  let disposed = false;

  const callTelegram = (method, ...args) => {
    if (!telegram || typeof telegram[method] !== 'function') {
      throw new Error(`telegram.${method} 不可用`);
    }
    return telegram[method](...args);
  };

  /** 分多条发送时，终态文本里标注完整内容的位置；单条时返回 null。 */
  const detailNote = (entry) =>
    entry.parts > 1 ? `（完整内容见上方 ${entry.parts - 1} 条消息）` : null;

  /** 尽力把卡片改成终态（去掉按钮）；失败只记日志，绝不影响审批结果。 */
  async function rewriteCard(chatId, messageId, text) {
    if (chatId === null || chatId === undefined || messageId === null || messageId === undefined) {
      return;
    }
    try {
      await callTelegram('editMessageText', chatId, messageId, text, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      error(`审批卡片编辑失败（结果不受影响）: ${err?.message ?? err}`);
    }
  }

  /** 清掉一条挂起项的定时器与 abort 监听。 */
  function release(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.signal && entry.onAbort) {
      try {
        entry.signal.removeEventListener('abort', entry.onAbort);
      } catch {
        /* 某些 AbortSignal 实现没有 removeEventListener，忽略 */
      }
      entry.onAbort = null;
    }
  }

  /**
   * 结束一条挂起项：清资源 → resolve → 改卡片。
   *
   * @param {string} id
   * @param {'allowed-once'|'rejected'|'cancelled'} outcome
   * @param {string} status 第 1 行显示的终态词（已允许 / 已拒绝 / 已取消 / 已超时）
   * @param {string} note   日志备注
   * @param {{chatId?: (string|number), messageId?: (string|number)}} [where] 优先用回调带来的位置
   * @returns {boolean} 是否命中一条挂起项
   */
  function finalize(id, outcome, status, note, where = {}) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    entry.status = status;
    release(entry);
    log(`审批 ${id} → ${outcome}${note ? `（${note}）` : ''}`);
    try {
      entry.resolve(outcome);
    } catch (err) {
      error(`审批 ${id} resolve 失败: ${err?.message ?? err}`);
    }
    void rewriteCard(
      where.chatId ?? entry.chatId,
      where.messageId ?? entry.messageId,
      cardText(entry.request, status, detailNote(entry)),
    );
    return true;
  }

  /**
   * waterfall 监听者。
   *
   * 只要还没「接手」，任何异常都必须 `next()`（交给别的应答者，最坏是失败关闭）；
   * 一旦接手（已返回 Promise），就只能 resolve，不能再 next()。
   */
  function onApprovalRequest(request, next) {
    let chatId;
    try {
      if (disposed) return next();
      if (!telegram || typeof telegram.sendMessage !== 'function') return next();
      chatId = typeof getChatId === 'function' ? getChatId() : null;
      if (chatId === null || chatId === undefined) return next();
      if (claimed.has(request)) return next(); // 双注册去重：另一个监听点已接手
      claimed.add(request);
    } catch (err) {
      error(`审批桥接管判定异常（放行给下一个应答者）: ${err?.stack ?? err?.message ?? err}`);
      return next();
    }

    const id = makeId(pending);
    let resolveDecision;
    const decision = new Promise((resolve) => {
      resolveDecision = resolve;
    });
    const entry = {
      request,
      chatId,
      messageId: null,
      parts: 1,
      resolve: resolveDecision,
      timer: null,
      signal: null,
      onAbort: null,
      status: null,
    };
    pending.set(id, entry);

    // 超时 → cancelled（拒绝语义，绝不默许）
    entry.timer = setTimeout(() => {
      finalize(id, 'cancelled', '已超时', 'timeout');
    }, timeoutMs);

    // 请求被上游取消（回合结束 / 用户中止）→ cancelled
    const signal = request?.signal;
    if (signal && typeof signal.addEventListener === 'function') {
      entry.signal = signal;
      entry.onAbort = () => finalize(id, 'cancelled', '已取消', 'abort');
      if (signal.aborted) {
        // 已经中止：别再发卡片，直接按取消收尾（resolve 出去）。
        finalize(id, 'cancelled', '已取消', 'abort-already');
      } else {
        try {
          signal.addEventListener('abort', entry.onAbort, { once: true });
        } catch (err) {
          error(`监听 request.signal 失败（仍按超时兜底）: ${err?.message ?? err}`);
          entry.onAbort = null;
        }
      }
    }

    // 发卡片。发送失败 → 退回下一个应答者（还没承诺任何结果，可以 next()）。
    return (async () => {
      // 竞态：在发卡片之前就已被 abort/超时/dispose 收尾 → 不再发过期卡片。
      if (!pending.has(id)) return decision;
      try {
        const body = cardText(request, WAITING);
        // Telegram 单条上限 4096：用 telegram.js 现成的分条器，正文 ≤4000 时
        // 只会得到 1 条（按钮照旧挂上去），超长则自动分多条。
        const chunks = splitMessage(body);
        const keyboard = {
          inline_keyboard: [[
            { text: '✅ 允许一次', callback_data: `${OK_PREFIX}${id}` },
            { text: '❌ 拒绝', callback_data: `${NO_PREFIX}${id}` },
          ]],
        };
        // `reply_markup` 只挂在**最后一条**；记住最后一条的 message_id，
        // 之后的终态 editMessageText 只改这一条。
        let lastMessageId = null;
        for (let i = 0; i < chunks.length; i += 1) {
          const isLast = i === chunks.length - 1;
          const sent = await callTelegram(
            'sendMessage',
            chatId,
            chunks[i],
            isLast ? { reply_markup: keyboard } : {},
          );
          if (isLast) lastMessageId = sent?.message_id ?? null;
        }
        entry.parts = chunks.length;
        entry.messageId = lastMessageId;
        // 竞态：卡片发送途中被收尾 → 补一次编辑，确保按钮不会被留在那里。
        if (!pending.has(id)) {
          await rewriteCard(
            chatId,
            entry.messageId,
            cardText(request, entry.status ?? '已取消', detailNote(entry)),
          );
        }
      } catch (err) {
        error(`审批卡片发送失败（交回下一个应答者）: ${err?.stack ?? err?.message ?? err}`);
        pending.delete(id);
        release(entry);
        // 已经 resolve 过（极端竞态）就不再 next()，避免出现两个结果。
        // 正常路径下不会发生，这里只是防御。
        return next();
      }
      return decision;
    })();
  }

  /** 挂到一个 ctx 上；ctx.on 返回 disposer 就存起来。 */
  function registerOn(target, label) {
    try {
      if (!target || typeof target.on !== 'function') return;
      const off = target.on('approval/request', onApprovalRequest);
      offs.push(typeof off === 'function' ? off : null);
      log(`审批桥已监听 approval/request（${label}）`);
    } catch (err) {
      error(`审批桥注册失败（${label}）: ${err?.stack ?? err?.message ?? err}`);
    }
  }

  registerOn(ctx, '插件 ctx');
  // 根 ctx 必然没有 scope 标签，因此必然能收到 agent 作用域的 approval/request。
  // 仅当它与插件 ctx 不是同一个对象时才额外注册（WeakSet 保证不重复处理）。
  try {
    if (ctx && ctx.root && ctx.root !== ctx) registerOn(ctx.root, '根 ctx（作用域兜底）');
  } catch (err) {
    error(`读取 ctx.root 失败（仅用插件 ctx）: ${err?.message ?? err}`);
  }

  /**
   * 处理 Telegram 按钮回调。
   *
   * 同步返回 boolean：true = 是本模块的 data（已接手）；false = 不是。
   * 实际的应答/改卡片在后台完成 —— 调用方 `if (bridge.handleApprovalCallback(...)) return;`
   * 依赖同步返回值，所以这里**不能**是 async。
   */
  function handleApprovalCallback(data, query) {
    if (disposed) return false;
    const raw = String(data ?? '');
    const isOk = raw.startsWith(OK_PREFIX);
    const isNo = raw.startsWith(NO_PREFIX);
    if (!isOk && !isNo) return false;
    if (!telegram || typeof telegram.answerCallbackQuery !== 'function') return false;

    const id = raw.slice((isOk ? OK_PREFIX : NO_PREFIX).length);
    if (!id) return false;
    const outcome = isOk ? 'allowed-once' : 'rejected';
    const status = isOk ? '已允许' : '已拒绝';

    void (async () => {
      // Telegram 要求每次按钮按下都必须应答，无论后续成败。
      try {
        await callTelegram('answerCallbackQuery', query?.id);
      } catch (err) {
        error(`answerCallbackQuery 失败: ${err?.message ?? err}`);
      }

      const where = {
        chatId: query?.message?.chat?.id,
        messageId: query?.message?.message_id,
      };
      // 先 resolve（保证审批不因编辑失败而卡死），再改卡片。
      if (finalize(id, outcome, status, 'button', where)) return;
      // 超时/取消后再点的竞态：没有挂起项（没有 request 可重建正文），
      // 只把这张卡片收成一句提示，并去掉按钮。
      log(`审批回调 ${id} 无对应挂起项（可能已超时/取消）`);
      await rewriteCard(where.chatId, where.messageId, '⌛ 该审批请求已结束。');
    })();

    return true;
  }

  /** 卸载：清所有挂起项（一律 cancelled）+ 注销监听。 */
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [id, entry] of pending) {
      pending.delete(id);
      release(entry);
      try {
        entry.resolve('cancelled');
      } catch {
        /* 已 settle 的 Promise resolve 是 no-op，不会抛 */
      }
    }
    pending.clear();
    for (const off of offs) {
      try {
        if (typeof off === 'function') off();
      } catch (err) {
        error(`审批桥注销监听失败: ${err?.message ?? err}`);
      }
    }
    offs.length = 0;
    log('审批桥已卸载');
  }

  return { handleApprovalCallback, dispose };
}

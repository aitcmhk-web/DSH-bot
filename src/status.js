/**
 * 回合内的「活状态」：模型跑的时候把进度显示出来，不用干等。
 *
 *   TG   ：①「⏳ 正在处理…」占位消息，4s 一次编辑（已耗时 / ≈字每秒 / 最近动态）
 *          ② sendChatAction('typing') 每 4.5s 续期
 *          ③ 最终回答编辑进占位消息（markdown→HTML，超长自动分段补发）
 *          ④ 任何一步撞 Telegram 限流（429）都**按它给的 retry_after 排队重发**；
 *             编辑与整条重发都走不通时，整篇回答落盘兜底（见 finish 的口径）
 *   微信 ：微信没有编辑消息接口，只有「正在输入」状态：
 *          getConfig 拿 typing_ticket → sendTyping(1) 每 4.5s 续期 → 结束时 sendTyping(2)
 *          最终回答由调用方照常发送，本类只返回吐字速度小尾巴。
 *
 * 事件从哪来：runtime.onSessionEvent() 的 tool/call 与 assistant/message，
 * 由 index.js 喂进来（addNote / trackProgress），本类不碰 runtime。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { markdownToHtml, splitMessageHtml, sendRichTo } from './telegram.js';

const TOOL_LABELS = {
  bash: '💻 执行命令',
  read: '📖 读取文件',
  write: '📝 写入文件',
  edit: '✏️ 修改文件',
  glob: '🔍 查找文件',
  grep: '🔍 搜索内容',
  web_search: '🌐 联网搜索',
  web_fetch: '🌐 抓取网页',
  subagent: '🤖 派生一个子代理',
  subagent_fork: '🤖 派生一个子代理',
  todo_write: '📋 更新任务清单',
  present: '📦 交付文件',
  ask_user_question: '❓ 想问你一个问题',
  workflow: '⚙️ 运行工作流',
  create_goal: '🎯 设定目标',
  skill: '🧩 加载技能',
  job_output: '⏳ 等待后台任务',
  job_list: '📋 查看后台任务',
};

export function truncate(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** 工具调用 → 一行人话（认得出的给中文标签，认不出的原样）。 */
export function describeTool(name, rawArguments) {
  let args = {};
  try {
    args = typeof rawArguments === 'string' ? JSON.parse(rawArguments || '{}') : (rawArguments ?? {});
  } catch {}
  const hint =
    args.command ??
    args.file_path ??
    args.path ??
    args.pattern ??
    args.query ??
    args.url ??
    args.description ??
    args.objective ??
    '';
  const label = TOOL_LABELS[name] ?? `🔧 ${name}`;
  const detail = truncate(hint, 120);
  return detail ? `${label}\n${detail}` : label;
}

/**
 * 吐字速度采样器（TG / 微信共用同一套算法）。
 *
 * SDK 没有逐 token 流式，只有整段 assistant/message 事件，所以拿不到真实
 * 速率，只能采样估算。这里的计时方式每一处都有原因（见 window() 内注释），
 * 别「简化」。
 */
export class SpeedSampler {
  constructor(label) {
    /** 落日志用的通道标识，如 `tg` / `wx`。 */
    this.label = label;
    /** Epoch ms of the first streamed character of the current turn. */
    this.firstCharAt = null;
    /** 本轮已吐字数（累加）。 */
    this.lastCharCount = 0;
    this.lastCharAt = null;
    /** 整轮起点 = 消息进来 / prompt 发出那一刻，用作兜底计时。 */
    this.turnStartedAt = null;
  }

  /** 开新一轮：清零采样，并记下整轮起点（兜底计时用）。 */
  reset() {
    this.firstCharAt = null;
    this.lastCharCount = 0;
    this.lastCharAt = null;
    this.turnStartedAt = Date.now();
  }

  /**
   * 记录一次「已经吐了多少字」的快照（整段文本长度，非增量）。
   * firstCharAt 只在本轮第一次吐字时落定；字数累加不是覆盖——
   * 一轮可能推多条 assistant/message（思考→工具→再思考），覆盖会抹掉前面的。
   */
  track(charCount) {
    const now = Date.now();
    if (!charCount) return;
    if (this.firstCharAt === null) this.firstCharAt = now;
    this.lastCharAt = now;
    this.lastCharCount += charCount;
  }

  /**
   * 均速的计时段落。起点 = firstCharAt；算出来 <1s 就回退到整轮起点
   * （SDK 整段一次性到达，首字时刻≈结束时刻，不回退会出 Infinity）。
   */
  window() {
    if (!this.lastCharCount) return null;
    const now = Date.now();
    const MIN_ELAPSED = 1; // 秒；低于这个数的均速会剧烈跳，没有展示意义
    let from = this.firstCharAt ?? this.turnStartedAt;
    if (from === null) return null;
    let elapsed = (now - from) / 1000;
    if (elapsed < MIN_ELAPSED && this.turnStartedAt !== null) {
      const whole = (now - this.turnStartedAt) / 1000;
      if (whole > elapsed) {
        from = this.turnStartedAt;
        elapsed = whole;
      }
    }
    if (!(elapsed > 0)) return null; // 兜底：除零/负值一律不显示，绝不吐 Infinity
    return { chars: this.lastCharCount, elapsed, rate: this.lastCharCount / elapsed };
  }

  /**
   * 收尾：落一条采样日志 + 返回要追加到回复末尾的小尾巴（无数据时 null）。
   */
  finish(log = () => {}) {
    const endedAt = Date.now();
    const w = this.window();
    const reason = !this.lastCharCount ? 'no-chars' : this.firstCharAt === null ? 'no-first-char' : 'ok';
    log(
      `[tps] chat=${this.label} ${reason} 首字=${
        this.firstCharAt ? new Date(this.firstCharAt).toISOString() : 'null'
      } 结束=${new Date(endedAt).toISOString()} 耗时=${
        w ? w.elapsed.toFixed(2) : 'null'
      }s 字数=${this.lastCharCount} 速率=${w ? w.rate.toFixed(1) : 'null'}`,
    );
    if (!w) return null;
    return `🚀 ≈${w.rate.toFixed(1)} 字/秒 · 共 ${w.chars} 字`;
  }
}

const TYPING_RENEW_MS = 4500; // 4.5s：微信 status=1 约 11s 自动消失，必须续期
const PROGRESS_TICK_MS = 4000; // 进度消息编辑间隔。旧版 2s 太频，长回合里会撞 Telegram 限流
const EDIT_DEBOUNCE_MS = 2000; // 同一批动态合并成一次编辑的去抖窗口
const RATE_LIMIT_WAIT_MAX_MS = 90_000; // 单次限流最多等这么久（TG 有时让等 60s 以上）
// 一轮收尾排队重发的等待总预算，超了就走落盘兜底。可用 DSH_BOTPLUGIN_RATE_LIMIT_BUDGET_MS 覆盖（自测与现场救急用）。
const RATE_LIMIT_BUDGET_MS = Number(process.env.DSH_BOTPLUGIN_RATE_LIMIT_BUDGET_MS ?? '') || 180_000;

/**
 * 429 的等待毫秒：照 Telegram 给的 `retry_after` 等，单次封顶 RATE_LIMIT_WAIT_MAX_MS。
 * @param {any} err Telegram 客户端抛出的错误（业务错误带 errorCode / parameters）
 * @returns {number|null} 等待毫秒；不是限流（429）时回 null
 */
function rateLimitWaitMs(err) {
  if (Number(err?.errorCode) !== 429) return null;
  const seconds = Math.max(1, Number(err?.parameters?.retry_after ?? 5));
  return Math.min(seconds * 1000, RATE_LIMIT_WAIT_MAX_MS);
}

/** 睡一会儿（定时器 unref：不影响进程退出）。 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 落盘文件名用的时间戳。 */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 未送达回答的落盘目录。优先 `DSH_BOTPLUGIN_UNDELIVERED_DIR`，否则放 DSH_BOT_DIR（再退 ~/.dsh）下的 `未送达/`。
 * 用途：Telegram 限流到实在发不出去时，把整篇回答留在盘上，⛔ 不许答案凭空消失。
 */
function undeliveredDir() {
  const explicit = process.env.DSH_BOTPLUGIN_UNDELIVERED_DIR;
  if (explicit) return explicit;
  const base = process.env.DSH_BOT_DIR || join(homedir(), '.dsh');
  return join(base, '未送达');
}

export class LiveStatus {
  /**
   * @param {object} opts
   * @param {'tg'|'wx'} opts.kind
   * @param {object} [opts.telegram]  TG 实例（kind='tg' 必填）
   * @param {number|string} [opts.chatId]  TG 会话 id（kind='tg' 必填）
   * @param {object} [opts.weixin]  微信实例（kind='wx' 必填）
   * @param {string} [opts.wxUserId]  微信侧 id（kind='wx' 必填）
   * @param {string} [opts.contextToken]  微信 context_token（拿 typing_ticket 用）
   */
  constructor({ kind, telegram, chatId, weixin, wxUserId, contextToken, log = () => {}, error = () => {} } = {}) {
    this.kind = kind;
    this.telegram = telegram;
    this.chatId = chatId;
    this.weixin = weixin;
    this.wxUserId = wxUserId;
    this.contextToken = contextToken;
    this.log = log;
    this.error = error;
    this.messageId = null;
    this.notes = [];
    this.startedAt = Date.now();
    this.typingTimer = null;
    this.tickTimer = null;
    this.editTimer = null;
    this.lastRendered = '';
    /** Epoch ms before which Telegram has asked us not to edit again. */
    this.editBlockedUntil = 0;
    this.closed = false;
    this.sampler = new SpeedSampler(kind);
    this.sampler.reset();
  }

  // ------------------------------------------------------------------ TG --

  async begin() {
    if (this.kind === 'wx') return this.#beginWxTyping();
    try {
      const sent = await this.telegram.sendMessage(this.chatId, '⏳ 正在处理…');
      this.messageId = sent.message_id;
    } catch (err) {
      this.error(`占位消息发不出(本轮没有进度显示): ${err.message}`);
    }
    this.typingTimer = setInterval(() => {
      this.telegram.sendChatAction(this.chatId, 'typing').catch(() => {});
    }, TYPING_RENEW_MS);
    this.typingTimer.unref?.();
    this.tickTimer = setInterval(() => this.#scheduleEdit(), PROGRESS_TICK_MS);
    this.tickTimer.unref?.();
    this.telegram.sendChatAction(this.chatId, 'typing').catch(() => {});
  }

  /** 加一条动态（工具调用 / 助手文字）。只留最近 12 条。 */
  addNote(note) {
    this.notes.push(truncate(note, 800));
    if (this.notes.length > 12) this.notes.splice(0, this.notes.length - 12);
    this.#scheduleEdit();
  }

  /** 记录一次吐字快照（整轮文本长度，委托 SpeedSampler）。 */
  trackProgress(charCount) {
    this.sampler.track(charCount);
  }

  render() {
    const seconds = Math.round((Date.now() - this.startedAt) / 1000);
    const tps = this.sampler.window();
    let header = `⏳ 正在处理… (${seconds}s)`;
    if (tps) {
      header += `\n🚀 ≈${tps.rate.toFixed(1)} 字/秒 · 已生成 ${tps.chars} 字`;
    }
    const recent = this.notes.slice(-3);
    return recent.length === 0 ? header : `${header}\n\n${recent.join('\n\n')}`;
  }

  #scheduleEdit() {
    if (this.closed || !this.messageId || this.editTimer) return;
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      this.#flush();
    }, EDIT_DEBOUNCE_MS);
    this.editTimer.unref?.();
  }

  async #flush() {
    if (this.closed || !this.messageId) return;
    // Telegram 限制单条消息的编辑频率，429 会带 retry_after，照它说的等。
    if (Date.now() < this.editBlockedUntil) return;
    const text = this.render();
    if (text === this.lastRendered) return;
    // 只有真的编辑上去了才记住，否则一次被拒的编辑会让进度消息永远停在旧文本。
    // ⚠️ 进度文本按纯文本编辑（不带 parse_mode）：动态里有工具输出的尖括号
    //    之类，按 HTML 解析会被 Telegram 拒掉。只有 finish() 的最终回答才转 HTML。
    if (await this.#safeEdit(text)) this.lastRendered = text;
  }

  /** @returns {Promise<boolean>} 是否编辑成功。 */
  async #safeEdit(text, parseMode) {
    try {
      await this.telegram.editMessageText(this.chatId, this.messageId, text, parseMode ? { parse_mode: parseMode } : {});
      return true;
    } catch (err) {
      if (err.errorCode === 429) {
        const retryAfter = Math.max(1, Number(err.parameters?.retry_after ?? 5));
        this.editBlockedUntil = Date.now() + retryAfter * 1000;
        this.error(`进度消息被限流,${retryAfter}s 内不再编辑`);
        return false;
      }
      // 文本没变时 Telegram 会回 400 "message is not modified"，属正常，不刷日志。
      if (!String(err.description ?? err.message).includes('not modified')) {
        this.error(`进度消息编辑失败: ${err.message}`);
      }
      return false;
    }
  }

  /**
   * 收尾并交付（kind='tg'）：把最终回答编辑进占位消息
   * （markdown→HTML，第一段编辑进去，超出的分段照常补发），返回 null。
   * kind='wx'：取消「正在输入」，返回吐字速度小尾巴（由调用方拼在回答后发出）。
   *
   * 交付口径（2026-10-18 修，起因：线上出现过「占位消息永远停在『正在处理』、答案丢掉」）：
   *   ① 任何一步撞 Telegram 限流（429）都**按它给的 retry_after 排队重发**，一轮最多等 RATE_LIMIT_BUDGET_MS；
   *   ② 分段补发失败**不再静默吞掉**（旧版是 `.catch(() => {})`），同样排队重试并记日志；
   *   ③ 编辑与整条重发都走不通时，**整篇回答落盘兜底**（见 #dumpUndelivered），⛔ 绝不让答案凭空消失。
   * 其余失败（占位消息被删、过期等）照旧降级为整条 sendRich 重发 —— 宁可重复也不能丢回答。
   */
  async finish(answerText) {
    const tail = this.sampler.finish(this.log);
    if (this.kind === 'wx') {
      await this.#stopWxTyping();
      return tail;
    }
    this.#clearTimers();
    this.closed = true;
    const body = tail ? `${answerText}\n\n${tail}` : String(answerText ?? '');
    const deadline = Date.now() + RATE_LIMIT_BUDGET_MS;

    // 排版失败只降级成本轮纯文本，⛔ 不能因为排版发不出去就不发答案。
    let parts = [body];
    let extra = {};
    try {
      parts = splitMessageHtml(markdownToHtml(body));
      extra = { parse_mode: 'HTML' };
    } catch (err) {
      this.error(`最终回答排版失败，按纯文本发送: ${err.message}`);
    }

    let edited = false;
    if (this.messageId) {
      const first = parts[0];
      edited = await this.#deliverWithRetry(
        () => this.telegram.editMessageText(this.chatId, this.messageId, first, extra),
        deadline,
      );
      if (edited) this.lastRendered = first;
    }

    if (edited) {
      // 第一段已进占位消息，其余分段补发；某段彻底发不出去就落盘，⛔ 不留半篇在聊天里还不吭声。
      for (let i = 1; i < parts.length; i++) {
        const ok = await this.#deliverWithRetry(
          () => this.telegram.sendMessage(this.chatId, parts[i], extra),
          deadline,
        );
        if (!ok) {
          await this.#dumpUndelivered(body, `第 ${i + 1}/${parts.length} 段未送达`);
          break;
        }
      }
      return null;
    }

    // 占位消息这条路走不通（被删 / 过期 / 限流耗尽）—— 整条重发兜底。
    const resent = await this.#deliverWithRetry(
      () => sendRichTo(this.telegram, this.chatId, body),
      deadline,
    );
    if (!resent) await this.#dumpUndelivered(body, '编辑与整条重发都没送达');
    return null;
  }

  /**
   * 带排队重试地执行一次交付动作：撞 429 就按 retry_after 等，等够了再试。
   * @param {() => Promise<any>} action 交付动作（编辑占位消息 / 发新消息 / 整条重发）
   * @param {number} deadline 允许等待到什么时候（epoch ms）；再等就超预算了
   * @returns {Promise<boolean>} 送达为 true；不是限流、或预算不够，立即回 false（由调用方兜底）
   */
  async #deliverWithRetry(action, deadline) {
    for (;;) {
      try {
        await action();
        return true;
      } catch (err) {
        const wait = rateLimitWaitMs(err);
        if (wait === null || Date.now() + wait > deadline) {
          this.error(`回答交付未成: ${err.message}`);
          return false;
        }
        const seconds = Math.round(wait / 1000);
        this.error(`被 Telegram 限流，${seconds}s 后重发`);
        await this.#showRateLimited(seconds);
        await sleep(wait);
      }
    }
  }

  /** 等待限流期间把占位消息说清楚（best-effort：这条提示本身也可能被限流，失败不影响重发）。 */
  async #showRateLimited(seconds) {
    if (!this.messageId) return;
    try {
      await this.telegram.editMessageText(
        this.chatId,
        this.messageId,
        `⏳ 已生成，Telegram 限流中，约 ${seconds} 秒后发送…`,
      );
    } catch {
      /* 提示发不出去不影响重发 */
    }
  }

  /**
   * 兜底：整篇回答落盘（⛔ 宁可留文件也不丢答案），并把占位消息改成「未送达 + 文件路径」。
   * 目录：`DSH_BOTPLUGIN_UNDELIVERED_DIR`，未设时用 `DSH_BOT_DIR/未送达`（再退 `~/.dsh/未送达`）。
   */
  async #dumpUndelivered(body, why) {
    const dir = undeliveredDir();
    try {
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${stamp()}-${String(this.chatId ?? 'unknown').replace(/[^\w-]/g, '')}.md`);
      await writeFile(file, body, 'utf8');
      if (this.messageId) {
        await this.telegram
          .editMessageText(this.chatId, this.messageId, `❌ 回答未送达（${why}），已存到 ${file}`)
          .catch(() => {});
      }
      this.error(`回答未送达（${why}），已落盘: ${file}`);
    } catch (err) {
      this.error(`回答未送达（${why}），落盘也失败: ${err.message}`);
    }
  }

  /** 异常收尾：占位消息改成错误提示（微信则只取消正在输入）。 */
  async fail(detail) {
    const tail = this.sampler.finish(this.log);
    if (this.kind === 'wx') {
      await this.#stopWxTyping();
      return;
    }
    this.#clearTimers();
    this.closed = true;
    const text = `❌ ${detail}${tail ? `\n\n${tail}` : ''}`;
    const deadline = Date.now() + RATE_LIMIT_BUDGET_MS;
    if (this.messageId) {
      const ok = await this.#deliverWithRetry(
        () => this.telegram.editMessageText(this.chatId, this.messageId, text),
        deadline,
      );
      if (ok) return;
    }
    // 占位消息改不动：另发一条，同样排队重试（旧的 `.catch(() => {})` 会把报错也一起吞掉）。
    await this.#deliverWithRetry(() => this.telegram.sendMessage(this.chatId, text), deadline);
  }

  #clearTimers() {
    if (this.typingTimer) clearInterval(this.typingTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.editTimer) clearTimeout(this.editTimer);
    this.typingTimer = this.tickTimer = this.editTimer = null;
  }

  // ------------------------------------------------------------------ WX --

  async #beginWxTyping() {
    // 微信侧没有进度消息（客户端不渲染、无编辑接口），只能靠「正在输入」。
    // 只发一次 status=1 约 11s 后自动消失，所以每 4.5s 续期才能覆盖整个 turn；
    // 客户端约 15s 后会亮 2s/灭 2s 闪烁，调不掉，接受。
    let ticket = null;
    try {
      const cfg = await this.weixin.getConfig(this.wxUserId, this.contextToken);
      ticket = cfg?.typing_ticket;
    } catch (err) {
      this.error(`getConfig 失败(无法发送"正在输入"): ${err.message}`);
    }
    if (!ticket) return;
    const renew = () =>
      this.weixin
        .sendTyping(this.wxUserId, ticket, 1)
        .catch((err) => this.error(`typing 续期失败: ${err.message}`));
    renew();
    this.typingTimer = setInterval(renew, TYPING_RENEW_MS);
    this.typingTimer.unref?.();
  }

  async #stopWxTyping() {
    this.#clearTimers();
    this.closed = true;
    // 必须先停续期定时器再发 status=2，否则残留的 timer 会在取消后又点亮状态。
    try {
      const cfg = await this.weixin.getConfig(this.wxUserId, this.contextToken);
      const ticket = cfg?.typing_ticket;
      if (ticket) await this.weixin.sendTyping(this.wxUserId, ticket, 2);
    } catch (err) {
      this.error(`typing 取消失败: ${err.message}`);
    }
  }
}

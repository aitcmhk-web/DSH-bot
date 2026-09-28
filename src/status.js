/**
 * 回合内的「活状态」—— 从老 bot（BOT/bot.js 的 LiveStatus + SpeedSampler）
 * 同口径移植：模型跑的时候用户不是干等，而是能看到进度。
 *
 *   TG   ：①「⏳ 正在处理…」占位消息，2s 一次编辑（已耗时 / ≈字每秒 / 最近动态）
 *          ② sendChatAction('typing') 每 4.5s 续期
 *          ③ 最终回答**编辑进占位消息**（markdown→HTML，超长自动分段补发）
 *   微信 ：微信没有编辑消息接口，只有「正在输入」状态：
 *          getConfig 拿 typing_ticket → sendTyping(1) 每 4.5s 续期 → 结束时 sendTyping(2)
 *          最终回答由调用方照常发送，本类只返回吐字速度小尾巴。
 *
 * 事件从哪来：runtime.onSessionEvent() 的 tool/call 与 assistant/message，
 * 由 index.js 喂进来（addNote / trackProgress），本类不碰 runtime。
 */

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

/** 工具调用 → 一行人话（与老 bot 同款：认得出的给中文标签，认不出的原样）。 */
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
 * 吐字速度采样器（老 bot 2026-09-17 版原样移植，TG/微信共用同一口径）。
 *
 * SDK 没有逐 token 流式，只有整段 assistant/message 事件，所以拿不到真实
 * 速率，只能采样估算。计时口径的坑老 bot 都踩过（见 window() 内注释），
 * 移植时不许「简化」。
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
    /** 整轮起点 = 用户消息进来 / prompt 发出那一刻，用作兜底计时。 */
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
   * firstCharAt 只在本轮第一次吐字时落定；字数**累加**不是覆盖——
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

const TYPING_RENEW_MS = 4500; // 4.5s：对齐老 bot；微信 status=1 约 11s 自动消失，必须续期

export class LiveStatus {
  /**
   * @param {object} opts
   * @param {'tg'|'wx'} opts.kind
   * @param {object} [opts.telegram]  TG 实例（kind='tg' 必填）
   * @param {number|string} [opts.chatId]  TG 会话 id（kind='tg' 必填）
   * @param {object} [opts.weixin]  微信实例（kind='wx' 必填）
   * @param {string} [opts.wxUserId]  微信用户 id（kind='wx' 必填）
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
    this.tickTimer = setInterval(() => this.#scheduleEdit(), 2000);
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
    }, 1500);
    this.editTimer.unref?.();
  }

  async #flush() {
    if (this.closed || !this.messageId) return;
    // Telegram 限制单条消息的编辑频率，429 会带 retry_after，照它说的等。
    if (Date.now() < this.editBlockedUntil) return;
    const text = this.render();
    if (text === this.lastRendered) return;
    // 只有真的编辑上去了才记住，否则一次被拒的编辑会让进度消息永远停在旧文本。
    // ⚠️ 进度文本是**纯文本**编辑（不带 parse_mode）：动态里有工具输出的尖括号
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
   * 编辑失败/被限流时降级为整条 sendRich 重发 —— 宁可重复也不能丢回答。
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
    if (!this.messageId) {
      await sendRichTo(this.telegram, this.chatId, body);
      return null;
    }
    try {
      const html = markdownToHtml(body);
      const parts = splitMessageHtml(html);
      // 第一段编辑进占位消息；其余的作为新消息补发。
      const first = parts[0];
      const ok = await this.#safeEdit(first, 'HTML');
      if (ok) {
        this.lastRendered = first;
        for (let i = 1; i < parts.length; i++) {
          await this.telegram.sendMessage(this.chatId, parts[i], { parse_mode: 'HTML' }).catch(() => {});
        }
      } else {
        // 占位消息可能已被用户删除等 —— 整条重发兜底。
        await sendRichTo(this.telegram, this.chatId, body);
      }
    } catch (err) {
      this.error(`最终回答交付降级(整条重发): ${err.message}`);
      await sendRichTo(this.telegram, this.chatId, body).catch((e) =>
        this.error(`回答发送失败: ${e.message}`),
      );
    }
    return null;
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
    if (this.messageId) {
      const ok = await this.#safeEdit(text);
      if (ok) return;
    }
    await this.telegram.sendMessage(this.chatId, text).catch(() => {});
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
    // 实测（老 bot 2026-09-16）：只发一次 status=1 约 11s 后自动消失，
    // 每 4.5s 续期可覆盖整个 turn；客户端约 15s 后会亮 2s/灭 2s 闪烁，调不掉，接受。
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

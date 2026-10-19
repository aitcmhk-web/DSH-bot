/**
 * 回合内的「活状态」：模型跑的时候把进度显示出来，不用干等。
 *
 *   TG   ：①「⏳ 正在处理…」占位消息：**只在我出新话 / 新操作时才编辑一次**（⛔ 不做定时刷新——
 *             内容没变也照刷，白撞 Telegram 限流）。版式（2026-10-19 定）：
 *             **顶行 ＝ 我最新说的那句**（我还没开口时才是「⏳ 正在处理…」占位语，⛔ 不显示已耗时），
 *             底下滚动的是**操作**（工具标签 / 📌 进度行），两下互不影响；有实测吐字时顶行下缀一行速度
 *          ② sendChatAction('typing') 每 4.5s 续期
 *          ③ 收尾**把占位气泡删掉**（2026-10-20 起：⛔ 不再留「✅ 已回复」那行）——
 *             **占位消息只报进度，⛔ 不承载最终回答**。
 *             回答统一由节点广播到所有端点（见 index.js 收尾交付）。一条消息只许一个写者：
 *             同一轮里「进度编辑」与「收尾回答」抢同一条消息时，迟到的进度编辑会把回答盖回去，
 *             日志里还看不出异常——2026-10-19 线上丢件就是这么丢的。
 *          ④ 收尾删气泡删不动只记日志（⛔ 不影响回答的广播）；回答自己送不到时另走落盘兜底
 *             （见导出的 落盘未送达）
 *   微信 ：微信没有编辑消息接口，只有「正在输入」状态：
 *          getConfig 拿 typing_ticket → sendTyping(1) 每 4.5s 续期 → 结束时 sendTyping(2)
 *          最终回答由调用方广播发出，本类只返回吐字速度小尾巴。
 *
 * 事件从哪来：runtime.onSessionEvent() 的 tool/call 与 assistant/message，
 * 由 index.js 喂进来（addNote / 推正文 / trackProgress），本类不碰 runtime。
 *
 * 进度口径（2026-10-18 定、2026-10-19 修订）：进度消息回答「我正在做什么」，分两路、互不影响——
 * ① **顶行 ＝ 我在回合里说的话**（正文按行取最新那句顶上去；一条消息送一次、重复送达不重刷，
 *    代码块与空行不进，见 推正文）；
 * ② **下面滚动的是操作**：带 `[进度]` 标记的行（带 📌，⛔ 不在顶行重复）＋ 认得出的工具中文标签；
 * 标签后面接**具体在干什么**（跑哪条命令、看哪个文件），否则「跑命令」四个字等于没说话。
 * 思考原文（reasoning 块）一律不上屏，口令类字面量打码（见 遮口令）。
 * 工具标签可用 DSH_BOTPLUGIN_PROGRESS_TOOLS=0 关掉。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RATE_LIMIT_BUDGET_MS, rateLimitWaitMs } from './telegram.js';

const TOOL_LABELS = {
  bash: '🏃 跑命令',
  read: '📖 看文件',
  write: '🖊 写文件',
  edit: '🛠 改文件',
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

/** tool/call 的 `arguments` 是原始 JSON 字符串（也兼容已解析成对象的情形）。解析不出就给空对象。 */
function 取参(入参) {
  if (!入参) return {};
  if (typeof 入参 === 'object') return 入参;
  try {
    const 值 = JSON.parse(String(入参));
    return 值 && typeof 值 === 'object' ? 值 : {};
  } catch {
    return {};
  }
}

/** 口令类字面量一律打码：进度消息要进聊天记录，口令不该留痕；其余内容照实显示。 */
function 遮口令(文) {
  return String(文)
    .replace(/((?:PGPASSWORD|PASSWORD|PASSWD|TOKEN|SECRET|APIKEY|API_KEY)[ \t]*[=:][ \t]*)(\S+)/gi, '$1***')
    .replace(/(Bearer[ \t]+)(\S+)/gi, '$1***');
}

/** 只留文件名：目录前缀对「在干什么」没有信息量，还占满一行。 */
function 文件名(路) {
  const 文 = String(路 ?? '').replace(/\s+/g, ' ').trim();
  if (!文) return '';
  const 切 = Math.max(文.lastIndexOf('/'), 文.lastIndexOf('\\'));
  return 切 >= 0 ? 文.slice(切 + 1) : 文;
}

/** 每个工具「具体在干什么」的那一句。给不出就返回空串（只剩标签）。 */
function 摘要(name, 参) {
  const 首行 = (文) => String(文 ?? '').split('\n').map((x) => x.trim()).filter(Boolean)[0] ?? '';
  switch (name) {
    case 'bash':
      return truncate(遮口令(首行(参.command ?? 参.cmd)), 90);
    case 'read':
    case 'edit':
    case 'write':
    case 'present':
      return 文件名(参.file_path ?? 参.path);
    case 'glob':
      return truncate(String(参.pattern ?? ''), 60);
    case 'grep':
      return truncate(String(参.pattern ?? ''), 60);
    case 'web_search': {
      const 问 = Array.isArray(参.queries) ? 参.queries[0] : 参.query;
      return truncate(String(问 ?? ''), 60);
    }
    case 'web_fetch':
      return truncate(String(参.url ?? ''), 80);
    case 'subagent':
    case 'subagent_fork':
      return truncate(String(参.description ?? ''), 40);
    case 'job_output':
    case 'job_kill':
      return truncate(String(参.job_id ?? ''), 20);
    default:
      return '';
  }
}

/** 工具调用 → 一行人话：`动作标签：具体在干什么`。
 *  入参：工具名 ＋ tool/call 的 `arguments`（原始 JSON 字符串或对象，可缺）。
 *  出参：一行文本；抠不出细节时只回标签，⛔ 不编占位词。
 *  口径（2026-10-18 修订）：老板要看**真命令、真文件名**，否则「跑命令」等于没说；
 *  口令类字面量打码（见 遮口令），思考原文仍不上屏。副作用：无。 */
export function describeTool(name, 入参) {
  const 标 = TOOL_LABELS[name] ?? `🔧 ${String(name ?? '工具')}`;
  const 尾 = 摘要(name, 取参(入参));
  return 尾 ? `${标}：${尾}` : 标;
}

/** 单条进度动态的字数上限。 */
const PROGRESS_NOTE_MAX = 120;

/** 进度行标记：我（助手）在回合里主动报的一句「正在做什么」。中括号全半角都认。 */
const 进度标记 = /^[\[【［]\s*进度\s*[\]】］]\s*(.*)$/;

/** 是否把工具中文标签也显示在进度里（默认显示；`DSH_BOTPLUGIN_PROGRESS_TOOLS=0` 只留进度行）。 */
const 显示工具标签 = process.env.DSH_BOTPLUGIN_PROGRESS_TOOLS !== '0';

/**
 * 从一段助手正文里挑出进度行。入参：正文（可空）。出参：进度文本数组（已去标记、掐到 120 字，空行丢掉）。
 * 副作用：无。口径：只认 `[进度] …` 这类显式标记——其余正文（含思考）一律不进进度消息。
 */
export function 挑进度行(text) {
  return String(text ?? '')
    .split('\n')
    .map((行) => 行.trim().match(进度标记))
    .filter(Boolean)
    .map((m) => truncate(m[1], PROGRESS_NOTE_MAX))
    .filter(Boolean);
}

/**
 * 吐字速度采样器（TG / 微信共用同一套算法）。
 *
 * 速率口径 = 模型真正吐正文的时间，不含工具调用、等网络、思考停顿：
 * 调用方从每条 `assistant/message` 的 `stream` 里量出正文块的跨度（`text-chunks`
 * 的 dt 之和）一并传进来，按轮累加。⛔ 不用整轮墙钟兜底——墙钟含等首字、工具
 * 与思考停顿，算出来不是吐字速度；实测不足 1s 时宁可不显示。
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
    /** 本轮正文流实测毫秒（累加，只算块间隔，不含工具与停顿）。 */
    this.activeMs = 0;
    /** 整轮起点 = 消息进来 / prompt 发出那一刻（只用于日志排查，不参与计时）。 */
    this.turnStartedAt = null;
  }

  /** 开新一轮：清零采样，并记下整轮起点（日志排查用）。 */
  reset() {
    this.firstCharAt = null;
    this.lastCharCount = 0;
    this.lastCharAt = null;
    this.activeMs = 0;
    this.turnStartedAt = Date.now();
  }

  /**
   * 记录一次吐字快照（整段文本长度，非增量）。
   * firstCharAt 只在本轮第一次吐字时落定；字数累加不是覆盖——
   * 一轮可能推多条 assistant/message（思考→工具→再思考），覆盖会抹掉前面的。
   *
   * @param {number} charCount 本条正文的字数
   * @param {number} [activeMs] 本条正文的实测生成毫秒（stream 里 text-chunks 的 dt 之和）；
   *   缺省 0 表示这次事件没带流时间，本轮累计不足 1s 时不显示速度。
   */
  track(charCount, activeMs = 0) {
    const now = Date.now();
    if (!charCount) return;
    if (this.firstCharAt === null) this.firstCharAt = now;
    this.lastCharAt = now;
    this.lastCharCount += charCount;
    this.activeMs += Math.max(0, Number(activeMs) || 0);
  }

  /**
   * 均速。只用实测口径（activeMs）：正文首块到末块的毫秒数。
   * 不足 1s 一律返回 null —— 短回复按块间隔折算会剧烈跳，宁可不上屏；
   * 也绝不退回整轮墙钟（墙钟含等首字、工具与思考停顿，算出来不是吐字速度）。
   */
  window() {
    if (!this.lastCharCount) return null;
    const MIN_ELAPSED = 1; // 秒；不足 1s 的实测会剧烈跳，不上屏也不落速率
    const measured = this.activeMs / 1000;
    if (measured < MIN_ELAPSED) return null;
    return { chars: this.lastCharCount, elapsed: measured, rate: this.lastCharCount / measured, measured: true };
  }

  finish(log = () => {}) {
    const endedAt = Date.now();
    const w = this.window();
    const reason = !this.lastCharCount ? 'no-chars' : this.firstCharAt === null ? 'no-first-char' : 'ok';
    log(
      `[tps] chat=${this.label} ${reason} 口径=${w ? '实测' : this.activeMs > 0 ? '不足' : 'none'} 首字=${
        this.firstCharAt ? new Date(this.firstCharAt).toISOString() : 'null'
      } 结束=${new Date(endedAt).toISOString()} 吐字耗时=${
        w ? w.elapsed.toFixed(2) : 'null'
      }s 实测毫秒=${this.activeMs} 字数=${this.lastCharCount} 速率=${w ? w.rate.toFixed(1) : 'null'}`,
    );
    if (!w) return null;
    return `🚀 ≈${w.rate.toFixed(1)} 字/秒 · 共 ${w.chars} 字`;
  }
}

const TYPING_RENEW_MS = 4500; // 4.5s：微信 status=1 约 11s 自动消失，必须续期
// 进度消息不再定时刷新：有新动态（新话 / 新工具标签）时 addNote 自己排一次编辑。
// 旧版每 2s（后改 4s）刷一次，头部秒数与速率一变就编辑，内容其实没变，白占限流额度。
const EDIT_DEBOUNCE_MS = 2000; // 同一批动态合并成一次编辑的去抖窗口
/** 占位消息的占位语：顶行还没话时说它。 */
const 占位语 = '⏳ 正在处理…';

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

/**
 * 兜底：把整篇正文落盘（⛔ 宁可留文件也不丢内容）。
 * 调用点：回答广播到某通道失败时（见 index.js 收尾交付）。
 * @param {string} 正文 完整正文
 * @param {string} 原因 未送达原因（写进日志）
 * @param {{记日志?: (m: string) => void, 渠道?: string}} [选项] 日志口与文件名里的渠道标识
 * @returns {Promise<string|null>} 落盘文件路径；落盘也失败时 null
 */
export async function 落盘未送达(正文, 原因, { 记日志 = () => {}, 渠道 = 'unknown' } = {}) {
  const dir = undeliveredDir();
  try {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${stamp()}-${String(渠道).replace(/[^\w-]/g, '')}.md`);
    await writeFile(file, String(正文 ?? ''), 'utf8');
    记日志(`回答未送达（${原因}），已落盘: ${file}`);
    return file;
  } catch (err) {
    记日志(`回答未送达（${原因}），落盘也失败: ${err.message}`);
    return null;
  }
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
    this.typingTimer = null;
    this.editTimer = null;
    this.lastRendered = '';
    /** 本条 `assistant/message` 已读过的正文（DSH 一条消息只送一次，这里主要防重复送达与前缀重复）。 */
    this.正文已读 = '';
    /** 正文三引号代码块的开关：块内不上屏（代码要看有最终回答）。 */
    this.在代码块里 = false;
    /** 我最新说的那一句＝占位消息的**顶行**（还没开口时顶行是占位语，见 render）。
     *  ⛔ 不进 notes——下面滚动的只放「操作」，两下互不影响。 */
    this.最新一句 = '';
    /** Epoch ms before which Telegram has asked us not to edit again. */
    this.editBlockedUntil = 0;
    /**
     * 「已经在飞」的那次进度编辑（Promise）。收尾前要等它落地：
     * 它晚一步返回就会在收尾之后又改一次气泡（同一条消息上的写者顺序问题）。
     */
    this.在飞编辑 = null;
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
    this.telegram.sendChatAction(this.chatId, 'typing').catch(() => {});
  }

  /** 加一条**操作**动态（下面滚动的那一路）。入参：note（文本）、
   *  类型（`'进度'` = 带 📌 的显式进度行，其它＝工具标签）。
   *  ⛔ 我说的话不走这里——它走 推正文，上屏在顶行。
   *  只留最近 12 条（上屏显示最近 3 条，见 render）。
   *  口径：只显示「正在做什么」——工具标签可用 `DSH_BOTPLUGIN_PROGRESS_TOOLS=0` 关掉；
   *  连着两条一样的不重复上屏。副作用：排一次进度消息编辑。 */
  addNote(note, 类型 = '工具') {
    if (类型 === '工具' && !显示工具标签) return;
    const 文本 = truncate(note, PROGRESS_NOTE_MAX);
    if (!文本) return;
    const 行 = 类型 === '进度' ? `📌 ${文本}` : 文本;
    if (this.notes[this.notes.length - 1] === 行) return;
    this.notes.push(行);
    if (this.notes.length > 12) this.notes.splice(0, this.notes.length - 12);
    this.#scheduleEdit();
  }

  /**
   * 把助手正文按行喂进进度消息。入参：本条 `assistant/message` 的整段正文（可空）。出参：无。
   *
   * 为什么这么做（2026-10-18 定、2026-10-19 修订）：进度消息回答「我正在做什么」，而我在回合里
   * 说的话就是最直接的答案。此前只认 `[进度]` 标记行，结果「我每次操作前说的话」在网页端看得到、
   * TG 那条占位消息里看不到。现在的版式（老板口径）：
   *   · **顶行 ＝ 我最新说的那句**——它顶掉原来「⏳ 正在处理…」那几个字，⛔ 不显示已耗时；
   *     顶行只有一格，故新的一句把前一句顶掉；
   *   · **下面滚动的只放「操作」**（工具标签 / 📌 进度行），与顶行互不影响；
   *   · **一条消息只送一次**——DSH 的正文是「一条 `assistant/message` 落定后送一次」
   *     （流式 chunk 只走瞬时帧，不进会话事件）；`正文已读` 游标兜住重复送达与前缀重复；
   *   · 代码块（``` / ~~~ 包着的）与空行不占顶行；
   *   · 带 `[进度]` 标记的行走 📌 那条路（进下面的操作区），⛔ 不在顶行重复。
   * 一句掐到 PROGRESS_NOTE_MAX 字。副作用：换了顶行就排一次进度消息编辑。
   *
   * @param {string} 整段正文
   */
  推正文(整段正文) {
    const 段 = String(整段正文 ?? '');
    if (!段) return;
    const 增量 = 段.startsWith(this.正文已读) ? 段.slice(this.正文已读.length) : 段;
    this.正文已读 = 段;
    if (!增量) return;
    let 换了 = false;
    for (const 原始 of 增量.split('\n')) {
      const 行 = 原始.trim();
      if (!行) continue;
      if (行.startsWith('```') || 行.startsWith('~~~')) {
        this.在代码块里 = !this.在代码块里;
        continue;
      }
      if (this.在代码块里) continue;
      if (进度标记.test(行)) continue;
      this.最新一句 = truncate(行, PROGRESS_NOTE_MAX);   // 顶行只有一格：新的一句把前一句顶掉
      换了 = true;
    }
    if (换了) this.#scheduleEdit();
  }

  /**
   * 记录一次吐字快照（整轮文本长度 ＋ 本次正文实际耗时，委托 SpeedSampler）。
   *
   * @param {number} charCount 整轮累计正文长度
   * @param {number} [activeMs] 本次文本块首块到末块的毫秒数（缺省 0）
   */
  trackProgress(charCount, activeMs = 0) {
    this.sampler.track(charCount, activeMs);
  }

  render() {
    // 顶行＝我最新说的那句（老板口径 2026-10-19：我的话顶掉「正在处理」那几个字，⛔ 不显示已耗时）；
    // 我还没开口时顶行才是占位语。下面滚动的只放「操作」，两下互不影响。
    const tps = this.sampler.window();
    let 文 = this.最新一句 || 占位语;
    // 收尾后不再显示速度：速度小尾巴跟回答走（回答由节点广播发出），气泡上留着是重复。
    if (tps && !this.closed) {
      文 += `\n🚀 ≈${tps.rate.toFixed(1)} 字/秒 · 已生成 ${tps.chars} 字`;
    }
    const recent = this.notes.slice(-3);
    return recent.length === 0 ? 文 : `${文}\n\n${recent.join('\n')}`;
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
    // 「在飞」留痕：收尾要等这一次落地（见 finish），否则它晚一步返回会在收尾之后又改一次气泡。
    const 在飞 = this.#safeEdit(text);
    this.在飞编辑 = 在飞;
    // 只有真的编辑上去了才记住，否则一次被拒的编辑会让进度消息永远停在旧文本。
    // ⚠️ 进度文本按纯文本编辑（不带 parse_mode）：动态里有工具输出的尖括号
    //    之类，按 HTML 解析会被 Telegram 拒掉（最终回答走广播，不经这里排版）。
    const ok = await 在飞;
    if (this.在飞编辑 === 在飞) this.在飞编辑 = null;
    if (ok) this.lastRendered = text;
    // 兜底：回来时已经收尾 → 这次迟到的进度编辑不再上屏（收尾后气泡只可能被删或被标「未送达」）。
    if (this.closed) return;
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
   * 收尾（kind='tg'）：清定时器、等在飞编辑落地、打上「已收尾」标记；**⛔ 不动占位气泡**。
   *   （2026-10-20 老板定「去掉气泡收尾」：不再写「✅ 已回复」那行——没意义，而且气泡顶行
   *   是「我最新说的一句话」，会跟回答尾巴重复。气泡的去留在回答进窗口后由调用方定：
   *   送达 → `清气泡()` 删掉；没送达 → `标未送达()` 留证。）
   *   ⛔ 不接管最终回答（回答统一由节点广播到所有端点，见 index.js 收尾交付）。
   * kind='wx'：取消「正在输入」。
   * @returns {Promise<string|null>} 吐字速度小尾巴，由调用方拼在回答后一起广播
   */
  async finish() {
    const tail = this.sampler.finish(this.log);
    if (this.kind === 'wx') {
      await this.#stopWxTyping();
      return tail;
    }
    this.#clearTimers();
    // 先等已经在飞的那次进度编辑落地：收尾后这条气泡只可能被删、或被标「未送达」。
    if (this.在飞编辑) await this.在飞编辑.catch(() => {});
    this.closed = true;
    return tail;
  }


  /**
   * 带排队重试地执行一次收尾动作（改占位消息 / 另发一条）：撞 429 就按 retry_after 等，等够了再试。
   * @param {() => Promise<any>} action 收尾动作
   * @param {number} deadline 允许等待到什么时候（epoch ms）；再等就超预算了
   * @returns {Promise<boolean>} 成功为 true；不是限流、或预算不够，立即回 false（由调用方兜底）
   */
  async #deliverWithRetry(action, deadline) {
    for (;;) {
      try {
        await action();
        return true;
      } catch (err) {
        const wait = rateLimitWaitMs(err);
        if (wait === null || Date.now() + wait > deadline) {
          this.error(`收尾消息未成: ${err.message}`);
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
   * 把占位消息标成「回答未送达 ＋ 落盘路径」（收尾之后仍可改；失败只记日志）。
   * 调用点：调用方发现回答没送达到本通道时（见 index.js 收尾交付）。
   * @param {string} 原因 未送达原因
   * @param {string|null} 文件 落盘路径（落盘也失败时传 null）
   */
  async 标未送达(原因, 文件) {
    if (!this.messageId) return;
    const 文本 = `❌ 回答未送达（${原因}），${文件 ? `已存到 ${文件}` : '落盘也失败'}`;
    if (await this.#safeEdit(文本)) this.lastRendered = 文本;
  }

  /**
   * 收尾删掉占位进度气泡（2026-10-20 老板定「去掉气泡收尾」）。
   *   为什么删：旧收尾在原文下补一行「✅ 已回复」，既没意义，又让气泡顶行那句
   *   「我最新说的一句话」跟刚广播出去的回答尾巴重复。
   * 调用点：回答**已进窗口**之后（见 index.js 收尾交付）；没送达时改走 `标未送达()`。
   * 失败只记日志，⛔ 不影响回答（回答走节点广播，与这条气泡是两回事）。
   * @returns {Promise<boolean>} 是否真删掉
   */
  async 清气泡() {
    if (this.kind !== 'tg' || !this.messageId) return false;
    try {
      await this.telegram.deleteMessage(this.chatId, this.messageId);
      return true;
    } catch (err) {
      this.error(`占位气泡没删掉（回答已进窗口，不影响）: ${err.message}`);
      return false;
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
    if (this.editTimer) clearTimeout(this.editTimer);
    this.typingTimer = this.editTimer = null;
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

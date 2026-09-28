/**
 * Weixin iLink 接入层 —— 从 BOT/weixin.js 搬运而来。
 *
 * 协议对齐官方 `@tencent-weixin/openclaw-weixin@2.4.8`：
 *   - 长轮询收消息（getupdates，带 get_updates_buf 游标）
 *   - 发文字消息（sendmessage）
 *   - 发送"正在输入"（getconfig + sendtyping）
 *
 * ⚠️ 与原版的差异（全部是「必须改」，没有一条是「我想改」）：
 *
 *   ① **凭据来源从「磁盘文件」改成「调用方传入」**。
 *      原版把 token 存在 `weixin-account.json` 里、路径写死在模块旁。
 *      插件是发布给别人的，凭据该由宿主（插件配置）持有，不该让插件自己
 *      决定往哪儿读写文件。所以 `load()` 依旧保留（兼容读文件），
 *      但更推荐 `adopt({token, baseUrl, botId, ownerWxUserId})` 直接注入。
 *
 *   ② `baseUrl` / 账号文件路径从 `process.env` 改走 `options`。
 *      理由同 telegram.js：多用户/多实例不能靠共享的进程环境变量区分。
 *      env 读取保留为**回退**，只为了不破坏现有测试脚本的用法。
 *
 *   ③ ⚠️ 原版 `reconnect()` 里写 `this._contextToken = null` 和
 *      `this._typingTicket = null` —— 但这**两个字段在类里根本不存在**
 *      （类只声明了 token/baseUrl/botId/ownerWxUserId/enabled）。
 *      也就是说它清的是两个**临时属性**，真正的上下文缓存如果存在别处就清不掉。
 *      搬运时**保持原样**（不改行为），但把这一点标出来 —— 见下方 TODO 注释。
 *      这是「搬的时候发现了但没擅自改」的东西，需要用户（我）确认真正的缓存位置。
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

// 与官方 openclaw-weixin@2.4.8 对齐的报头。
const CHANNEL_VERSION = '2.4.8';
const ILINK_APP_ID = 'bot';
const BOT_AGENT = 'DSH-Weixin/1.0.0';
const DEFAULT_LONG_POLL_MS = 30_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((p) => parseInt(p, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);

/** 消息 item 类型。 */
export const WX_ITEM_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
};

/** 提取一条 WeixinMessage 的纯文字内容（若含文本 item 则返回，否则 null）。 */
export function extractText(message) {
  const item = message?.item_list?.find((it) => it?.type === WX_ITEM_TYPE.TEXT && it?.text_item?.text);
  return item?.text_item?.text ?? null;
}

/** 提取一条 WeixinMessage 的语音文字（优先用服务端已转的 text，否则返回 null）。 */
export function extractVoiceText(message) {
  const item = message?.item_list?.find((it) => it?.type === WX_ITEM_TYPE.VOICE);
  // 微信 iLink 服务端已经做了语音转文字，结果在 voice_item.text
  return item?.voice_item?.text ?? null;
}

/** 判断一条消息是否来自用户（message_type=1 表示 USER）。 */
export function isUserMessage(message) {
  return message?.message_type === 1;
}

/**
 * Weixin iLink 客户端。
 *
 * 两种启用方式：
 *   · `new Weixin({accountFile})` + `load()`       —— 从文件读凭据（原版行为）
 *   · `new Weixin(...)` + `adopt({token, ...})`    —— 由调用方直接给凭据（插件推荐）
 */
export class Weixin {
  /**
   * @param {{accountFile?: string, apiRoot?: string}} [options]
   */
  constructor(options = {}) {
    this.token = null;
    this.baseUrl = (options.apiRoot ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.botId = null;
    this.ownerWxUserId = null; // 扫码者 = 主人
    this.enabled = false;
    // 缓存失效回调：reconnect() 会调它，让持有 context_token 缓存的调用方清空。
    // ⚠️ 由调用方注入 —— 缓存不在本类里，本类清不了别人的 Map。
    this.onInvalidate = typeof options.onInvalidate === 'function' ? options.onInvalidate : null;
    this.#accountFile = options.accountFile ?? null;
  }

  #accountFile;

  /** 直接注入凭据（插件路径：凭据来自配置，不落盘）。返回 true 表示可用。 */
  adopt({ token, baseUrl, botId, ownerWxUserId } = {}) {
    if (!token) return false;
    this.token = token;
    if (baseUrl) this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.botId = botId ?? null;
    this.ownerWxUserId = ownerWxUserId ?? null;
    this.enabled = true;
    return true;
  }

  /** 加载本地凭据文件。返回 true 表示可用。（原版行为，保留兼容） */
  load() {
    // env 回退只为不破坏现有测试脚本；插件里请用 options.accountFile。
    const accountFile = this.#accountFile ?? process.env.WEIXIN_ACCOUNT_FILE;
    if (!accountFile || !existsSync(accountFile)) return false;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(accountFile, 'utf8'));
    } catch (err) {
      console.error(`[wx] 读取凭据文件失败: ${err.message}`);
      return false;
    }
    if (!parsed?.token) {
      console.error('[wx] 凭据文件缺少 token（凭据不完整）');
      return false;
    }
    // env 指定的 baseUrl 优先（测试 stub 用）,否则用凭据里的,再回落到默认。
    const envRoot = process.env.WEIXIN_API_ROOT?.trim();
    return this.adopt({
      token: parsed.token,
      baseUrl: envRoot ? envRoot.replace(/\/$/, '') : parsed.baseUrl,
      botId: parsed.botId,
      ownerWxUserId: parsed.ownerWxUserId,
    });
  }

  #baseInfo() {
    return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
  }

  #headers() {
    const uint32 = Math.floor(Math.random() * 0xffffffff);
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(uint32, 0);
    const headers = {
      'Content-Type': 'application/json',
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(buf.readUInt32BE(0)), 'utf-8').toString('base64'),
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  async #post(endpoint, body, timeoutMs = DEFAULT_API_TIMEOUT_MS, signal) {
    if (!this.token) throw new Error('weixin not logged in');
    const url = new URL(endpoint, this.baseUrl.replace(/\/$/, '') + '/');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', () => controller.abort());
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 校验响应体里的 `ret`。腾讯代码的坑：服务端即使业务失败也返回 HTTP 200，
   * 通过响应体的 `ret` 字段给业务错误（如 `ret:-2 prepare failed`）。
   * 只检查 HTTP 状态码会把"其实没投递"当成成功 —— sendText 发微信会**静默丢**。
   * 对齐官方 openclaw-weixin api.js:422 的语义（`resp.ret !== 0` 即抛错）。
   */
  #expectOk(resp, label) {
    if (resp && resp.ret && resp.ret !== 0) {
      throw new Error(`weixin ${label} ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`);
    }
    return resp;
  }

  /**
   * 长轮询接收新消息。正常返回 { msgs, get_updates_buf }；
   * 客户端超时（长轮询正常返回空）时也返回空批次，由调用方重试。
   */
  async getUpdates(cursor, timeoutMs = DEFAULT_LONG_POLL_MS, abortSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);
    if (abortSignal?.aborted) controller.abort();
    else abortSignal?.addEventListener('abort', () => controller.abort());
    try {
      const resp = await this.#post(
        'ilink/bot/getupdates',
        { get_updates_buf: cursor ?? '', base_info: this.#baseInfo() },
        timeoutMs + 5000,
        controller.signal,
      );
      if (resp?.ret === 0 || resp?.ret === undefined) {
        return {
          msgs: resp?.msgs ?? [],
          get_updates_buf: resp?.get_updates_buf ?? cursor ?? '',
          ret: resp?.ret,
        };
      }
      // 非 0：会话可能超时（-14），交回调用方决定。
      // ⚠️ 即使 ret≠0，也要使用服务器返回的 get_updates_buf（可能是 -2 prepare failed）
      // 否则客户端无法推进游标，后续调用会一直用空 cursor 重试。
      return {
        msgs: [],
        get_updates_buf: resp?.get_updates_buf ?? cursor ?? '',
        ret: resp?.ret,
        errmsg: resp?.errmsg,
      };
    } catch (err) {
      if (err?.name === 'AbortError') return { msgs: [], get_updates_buf: cursor ?? '' };
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 发一条文字消息给用户，必须回传 context_token。
   * ⚠️ 必须带 `client_id`（每次随机生成）+ `from_user_id: ""` ——
   *    缺 `client_id` 时服务端返回 HTTP 200 + message_id 但**静默不投递**
   *    （2026-09-13 A/B 实测：带 client_id 能收到，不带收不到）。
   */
  async sendText(toUserId, text, contextToken) {
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: randomUUID(),
        message_type: 2, // BOT 发出
        message_state: 2, // FINISH
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [{ type: WX_ITEM_TYPE.TEXT, text_item: { text: String(text) } }],
      },
      base_info: this.#baseInfo(),
    };
    // ⚠️ 必须校验 `ret`：服务端业务失败（如 sessions/通道失效）也回 HTTP 200，
    // 不查 `ret` 会静默吞掉（用户端收不到、bot 端还不报错）。2026-09-13 实测
    // 本通道 sendmessage 返回 `{"ret":-2,"errmsg":"prepare failed"}`。
    // ⚠️ 必须 `return`：原版以前没有 return，导致 sendText() **永远返回 undefined**
    //    （2026-09-19 实测发现）—— 任何依赖返回值查 message_id / 判投递的代码都会静默失效。
    return this.#expectOk(await this.#post('ilink/bot/sendmessage', body), 'sendText');
  }

  /** 获取用户的 typing ticket（用于发送"正在输入"）。 */
  async getConfig(ilinkUserId, contextToken) {
    return this.#expectOk(
      await this.#post('ilink/bot/getconfig', {
        ilink_user_id: ilinkUserId,
        context_token: contextToken,
        base_info: this.#baseInfo(),
      }),
      'getConfig',
    );
  }

  /** 发送"正在输入"状态。 */
  async sendTyping(ilinkUserId, typingTicket, status = 1) {
    this.#expectOk(
      await this.#post('ilink/bot/sendtyping', {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
      }),
      'sendTyping',
    );
  }

  /**
   * 刷新微信通道：清除本地上下文缓存 + 尝试重新握手。
   * 当 sendmessage 返回 ret=-2（prepare failed）或 getUpdates 返回 ret=-2 时调用，
   * 等价于「伪过期」场景下的强制重连。
   *
   * ⚠️ 重要限制（2026-09-14 实证）：
   *   notifyStart() 只是通知服务端"我开始接收了"，它**不能刷新会话 / 获取新的 context_token**。
   *   当通道已经彻底失效时（ret=-2），notifystart 本身也返回 ret=-2 → 重连必然失败。
   *   真正的恢复方式是：**等待用户主动发一条消息给 bot**，getUpdates 长轮询收到新消息后，
   *   消息携带新鲜的 context_token → 通道自然恢复。
   *   因此本 reconnect() 只负责清除本地缓存（让旧 token 不再污染后续发送），
   *   实际恢复依赖入站消息触发。如果 reconnect() 本身也失败（notifyStart ret=-2），
   *   至少清除了缓存，不影响后续入站消息处理。
   *
   * ⚠️ 与 BOT 原版的差异（**这里改了行为，不是照抄**）：
   *   原版清的是 `this._contextToken` / `this._typingTicket`，但这两个字段
   *   在类里**根本不存在**（类字段只有 token/baseUrl/botId/ownerWxUserId/enabled）——
   *   也就是说原版的「清除缓存」是空操作，什么都没清。
   *   真正的 context_token 缓存由调用方持有（插件版在 index.js 的 wxContextTokens），
   *   所以本类改为：**广播一个 invalidate 事件**，让持有缓存的人自己清。
   *   照抄原样等于保留一个骗人的空操作。
   */
  async reconnect() {
    // 1. 通知缓存持有者：所有 context_token / typing_ticket 已失效
    if (typeof this.onInvalidate === 'function') {
      try { this.onInvalidate(); } catch { /* 清缓存失败不该挡住重连 */ }
    }

    // 2. 尝试重新向服务端注册/握手（可能失败，但至少缓存已清）
    try {
      await this.notifyStart();
    } catch {
      // notifyStart ret=-2: 通道仍死，但缓存已清除，不影响后续入站恢复
    }
  }

  /** 通知服务端本 channel 正在接收（可选的生命周期通知）。 */
  async notifyStart() {
    try {
      await this.#post('ilink/bot/msg/notifystart', { base_info: this.#baseInfo() });
    } catch {}
  }

  // sendHeartbeat() 已于 2026-09-15 删除：向 filehelper 发空消息并不能绕过
  // ret=-2，无法"激活"通道。通道恢复的唯一途径是用户入站消息刷新 context_token。
}

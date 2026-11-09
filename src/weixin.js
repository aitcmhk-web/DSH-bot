/**
 * Weixin iLink 接入层。
 *
 * 协议对齐官方 @tencent-weixin/openclaw-weixin@2.4.8：
 *   - 长轮询收消息（getupdates，带 get_updates_buf 游标）
 *   - 发文字消息（sendmessage）
 *   - 发送"正在输入"（getconfig + sendtyping）
 *
 * 凭据来源：推荐 adopt({token, baseUrl, botId, ownerWxUserId}) 由宿主注入；
 * load() 保留，从账号文件读凭据。baseUrl / 账号路径走 options（env 仅作回退）。
 * context_token 缓存由调用方持有；重连时本类广播 invalidate 事件让持有者清缓存。
 */

import { existsSync, readFileSync } from 'node:fs';
import { createDecipheriv, randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

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

/** 图片 AES key：兼容 base64(16 字节) 与 base64(32 位十六进制串) 两种。 */
function 解图片钥匙(钥, 标签) {
  const 解 = Buffer.from(String(钥 || ''), 'base64');
  if (解.length === 16) return 解;
  if (解.length === 32 && /^[0-9a-fA-F]{32}$/.test(解.toString('ascii'))) {
    return Buffer.from(解.toString('ascii'), 'hex');
  }
  throw new Error(`${标签}: aes_key 不是 16 字节或 32 位十六进制`);
}

/** 按文件头认图片类型；认不出按 JPEG，交给上层模型兜底。 */
function 认图片类型(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Weixin iLink 客户端。
 *
 * 两种启用方式：
 *   · `new Weixin({accountFile})` + `load()`       —— 从文件读凭据
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
    this.ownerWxUserId = null; // 扫码者 = owner 账号（凭据绑定到扫码人）
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

  /** 加载本地凭据文件。返回 true 表示可用。 */
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
   * 发一条文字消息给会话方，必须回传 context_token。
   * 必须带 client_id（每次随机生成）+ from_user_id: ""——
   *    缺 client_id 时服务端返回 HTTP 200 + message_id 但静默不投递。
   */
  async sendText(toUserId, text, contextToken) {
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: randomUUID(),
        message_type: 2, // bot 发出
        message_state: 2, // FINISH
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [{ type: WX_ITEM_TYPE.TEXT, text_item: { text: String(text) } }],
      },
      base_info: this.#baseInfo(),
    };
    // 必须校验 ret 并把结果 return：服务端业务失败（如通道失效）也回 HTTP 200，
    // 不查 ret 会静默吞掉（会话方收不到、bot 端不报错）。
    return this.#expectOk(await this.#post('ilink/bot/sendmessage', body), 'sendText');
  }

  /** 获取 typing ticket（用于发送"正在输入"）。 */
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
   * 下载并解密一条图片消息。入参：`image_item`（或含它的 item）。
   * 出参：{ data: Buffer, mediaType: string }。副作用：一次 CDN 下载；失败抛错。
   */
  async getImage(item) {
    const 图 = item?.image_item ?? item;
    const 媒 = 图?.media ?? null;
    if (!媒 || (!媒.encrypt_query_param && !媒.full_url)) {
      throw new Error('图片消息没有 CDN 地址');
    }
    // `aeskey` 是十六进制，`media.aes_key` 是 base64；统一成 base64 再解。
    const 钥 = 图.aeskey
      ? Buffer.from(String(图.aeskey), 'hex').toString('base64')
      : 媒.aes_key;
    if (!钥) throw new Error('图片消息没有解密钥匙');
    const 址 = 媒.full_url
      || `${DEFAULT_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(媒.encrypt_query_param)}`;
    const r = await fetch(址, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`图片 CDN 下载失败 HTTP ${r.status}`);
    const 密 = Buffer.from(await r.arrayBuffer());
    if (密.length > 20 * 1024 * 1024) throw new Error('图片超过 20MB');
    let 明;
    try {
      const 解 = createDecipheriv('aes-128-ecb', 解图片钥匙(钥, '图片'), null);
      明 = Buffer.concat([解.update(密), 解.final()]);
    } catch (e) {
      throw new Error(`图片解密失败：${e.message}`);
    }
    if (!明.length) throw new Error('图片解密后是空的');
    return { data: 明, mediaType: 认图片类型(明) };
  }

  /**
   * 刷新微信通道：清除本地上下文缓存 + 尝试重新握手。
   * 当 sendmessage 返回 ret=-2（prepare failed）或 getUpdates 返回 ret=-2 时调用，
   * 等价于「伪过期」场景下的强制重连。
   *
   * 重要限制：notifyStart() 不能刷新会话 / 获取新的 context_token。
   *   通道彻底失效（ret=-2）时，唯一恢复途径是下一条入站消息带来的
   *   新鲜 context_token。因此 reconnect() 只负责清除本地缓存并尝试重新握手，
   *   实际恢复依赖入站消息触发。
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

  // 通道恢复的唯一途径是入站消息刷新 context_token
  // （向 filehelper 发心跳不能激活失效通道，故无心跳逻辑）。
}

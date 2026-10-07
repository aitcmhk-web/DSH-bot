// weixin.js · 微信 iLink 通道客户端（移植自 BOT/src/weixin.js，血泪语义原样保留）
// 铁律（教训档第 16 条）：sendText/sendImage 唯一成功判据 = 返回带 message_id；
// ret:0 无 message_id = 服务端静默丢，HTTP 200 / ret:0 / 日志统统不算数。
// 发图形状（2026-10-05 接线）来自 openilink SDK：getuploadurl → CDN 加密上传 → sendmessage(image_item)。
import { existsSync, readFileSync } from 'node:fs';
import { createDecipheriv, createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
// CDN 上传基地址：iLink 约定与 API baseUrl 独立（对齐 openilink SDK DEFAULT_CDN_BASE_URL）
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CHANNEL_VERSION = '2.4.8';
const ILINK_APP_ID = 'bot';
const BOT_AGENT = 'DSH-Weixin/1.0.0';
const LONG_POLL_MS = 30_000;
const API_TIMEOUT_MS = 15_000;

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((p) => parseInt(p, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);

export const WX_ITEM_TYPE = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
const ENCRYPT_AES128_ECB = 1; // 对齐 openilink SDK 常量

// —— AES-128-ECB + PKCS7（node aes-128-ecb 默认带 PKCS7，与 SDK encrypt_aes_ecb 同）——
export function encryptAesEcb(plain, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** PKCS7 后密文长度（对齐 SDK aes_ecb_padded_size：n + (16 - n%16)）。 */
export function aesPaddedSize(n) {
  return n + (16 - (n % 16));
}

/** hex aeskey → sendmessage 的 aes_key 参数 = base64(hex字符串)（对齐 SDK _media_aes_key）。 */
export function aesKeyHexToParam(hex) {
  return Buffer.from(String(hex), 'utf8').toString('base64');
}

/** 一条消息里的纯文字（没有则 null）。 */
export function extractText(message) {
  const item = message?.item_list?.find((it) => it?.type === WX_ITEM_TYPE.TEXT && it?.text_item?.text);
  return item?.text_item?.text ?? null;
}

/** 语音的服务端转写文字（iLink 服务端已转好，在 voice_item.text；没有则 null）。 */
export function extractVoiceText(message) {
  const item = message?.item_list?.find((it) => it?.type === WX_ITEM_TYPE.VOICE);
  return item?.voice_item?.text ?? null;
}

/**
 * 图片下载信息：image_item → { url, aesKey } 或 null。（移植自 bot.js extractImageUrlFallback）
 * ⚠️ aes_key 有两种编码（对齐 SDK cdn/pic-decrypt.ts 的 parseAesKey）：
 *   - `image_item.aeskey`：hex 字符串（32 个 hex 字符）
 *   - `image_item.media.aes_key`：base64
 * 这里统一归一成 base64，喂给 decryptAesEcb，与语音侧同口径。
 */
export function extractImage(message) {
  const item = message?.item_list?.find((it) => it?.type === WX_ITEM_TYPE.IMAGE);
  const img = item?.image_item;
  if (!img) return null;
  const media = img.media;
  const url = media?.full_url || null;
  if (!url) return null;
  let aesKey = null;
  const hex = img.aeskey ? String(img.aeskey) : null;
  if (hex && /^[0-9a-fA-F]{32}$/.test(hex)) {
    aesKey = Buffer.from(hex, 'hex').toString('base64');
  } else if (media?.aes_key) {
    aesKey = media.aes_key;
  }
  if (!aesKey) return null;
  return { url, aesKey };
}

/** message_type=1 表示来自用户。 */
export function isUserMessage(message) {
  return message?.message_type === 1;
}

// 返回体形状随服务端版本漂移——深度找 message_id，宁可找全不误判
function findMessageId(obj, depth = 0) {
  if (depth > 4 || obj == null || typeof obj !== 'object') return undefined;
  if (obj.message_id != null) return obj.message_id;
  for (const v of Object.values(obj)) {
    const r = findMessageId(v, depth + 1);
    if (r != null) return r;
  }
  return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AES-128-ECB 解密：aesKeyBase64 两型归一（base64(16字节raw) / base64(hex字符串)）
export function decryptAesEcb(encrypted, aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  let key;
  if (decoded.length === 16) {
    key = decoded;
  } else if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    // hex-encoded key: base64 → hex string → raw bytes
    key = Buffer.from(decoded.toString('ascii'), 'hex');
  } else {
    throw new Error(`aes_key decode failed: got ${decoded.length} bytes`);
  }
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * createWeixin({ 凭据 | 凭据文件 })
 * 凭据 = { token, baseUrl?, botId?, ownerWxUserId? }（weixin-login.mjs 落盘的就是这个形状）
 * 返回 { getUpdates, sendSafe, botId } 或 null（凭据不可用）
 */
export function createWeixin(配置 = {}) {
  let 凭据 = 配置.凭据;
  if (!凭据 && 配置.凭据文件) {
    if (!existsSync(配置.凭据文件)) {
      console.error(`[wx] 凭据文件不存在：${配置.凭据文件}`);
      return null;
    }
    try {
      凭据 = JSON.parse(readFileSync(配置.凭据文件, 'utf8'));
    } catch (e) {
      console.error(`[wx] 凭据文件解析失败: ${e.message}`);
      return null;
    }
  }
  if (!凭据?.token) {
    console.error('[wx] 凭据缺少 token');
    return null;
  }
  const baseUrl = String(凭据.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const botId = 凭据.botId ?? null;

  function headers() {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(Math.floor(Math.random() * 0xffffffff), 0);
    const h = {
      'Content-Type': 'application/json',
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
      AuthorizationType: 'ilink_bot_token',
      // ⚠️ 原版口径：uint32 的十进制字符串转 base64（不能拿二进制字节转——会出乱码头，fetch 直接拒）
      'X-WECHAT-UIN': Buffer.from(String(buf.readUInt32BE(0)), 'utf-8').toString('base64'),
    };
    h.Authorization = `Bearer ${凭据.token}`;
    return h;
  }

  async function post(endpoint, body, timeoutMs = API_TIMEOUT_MS) {
    const url = new URL(endpoint, baseUrl + '/');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: controller.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  // 腾讯的坑：业务失败也回 HTTP 200，错误藏在响应体 ret 里
  function expectOk(resp, label) {
    if (resp && resp.ret && resp.ret !== 0) {
      throw new Error(`weixin ${label} ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`);
    }
    return resp;
  }

  // 长轮询收消息。返回 { msgs, buf }；客户端超时 = 正常空批次
  async function getUpdates(cursor) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LONG_POLL_MS + 5000);
    try {
      const resp = await post(
        'ilink/bot/getupdates',
        { get_updates_buf: cursor ?? '', base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT } },
        LONG_POLL_MS + 5000,
      );
      // ret≠0（如 -14 会话超时）也要用服务端回的 buf，否则游标卡死
      return {
        msgs: resp?.msgs ?? [],
        buf: resp?.get_updates_buf ?? cursor ?? '',
        ret: resp?.ret,
        errmsg: resp?.errmsg,
      };
    } catch (e) {
      if (e?.name === 'AbortError') return { msgs: [], buf: cursor ?? '' };
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // 底层发送：必须带 client_id + from_user_id:''（缺 client_id 会 HTTP 200 假成功）
  async function sendTextRaw(toUserId, text, contextToken) {
    return expectOk(
      await post('ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          ...(contextToken ? { context_token: contextToken } : {}),
          item_list: [{ type: WX_ITEM_TYPE.TEXT, text_item: { text: String(text) } }],
        },
        base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
      }),
      'sendText',
    );
  }

  // 三件套：message_id 判据 + 重试 2 次 + 最终显式失败（绝不静默）
  async function sendSafe(toUserId, text, contextToken) {
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const resp = await sendTextRaw(toUserId, text, contextToken);
        const mid = findMessageId(resp);
        if (mid != null) return { ok: true, message_id: mid };
        lastErr = new Error('ret:0 但无 message_id（服务端静默丢）');
      } catch (e) {
        lastErr = e;
      }
      if (i < 2) await sleep(3000);
    }
    return { ok: false, 错误: String(lastErr?.message ?? lastErr) };
  }

  // —— 图片：下载 CDN 加密图 → 魔数嗅探类型（移植自 bot.js downloadWeixinImage）——

  // 返回 { buffer, mime, ext }；调用方负责落盘（存临时文件）
  async function downloadImage(imageInfo) {
    const { url, aesKey } = imageInfo;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${凭据.token}` } });
    if (!res.ok) throw new Error(`微信图片下载失败：HTTP ${res.status}`);
    const plain = decryptAesEcb(Buffer.from(await res.arrayBuffer()), aesKey);
    // 魔数嗅探：微信图片常见 jpg/png/gif/webp，无扩展名可依，只能看头
    let mime = 'image/jpeg';
    let ext = '.jpg';
    if (plain.length > 12) {
      if (plain[0] === 0x89 && plain[1] === 0x50) { mime = 'image/png'; ext = '.png'; }
      else if (plain[0] === 0x47 && plain[1] === 0x49) { mime = 'image/gif'; ext = '.gif'; }
      else if (plain[0] === 0x52 && plain[1] === 0x49 && plain[8] === 0x57) { mime = 'image/webp'; ext = '.webp'; }
    }
    return { buffer: plain, mime, ext };
  }

  // —— 发图（2026-10-05 接线）：getuploadurl 拿预签名 → AES-128-ECB 加密传 CDN → sendmessage(image_item) ——
  // 请求形状来源：openilink SDK（github.com/openilink/openilink-sdk-python client.py upload_file/send_image、
  // openilink-sdk-go media.go SendImage），非编造。CDN 上传自重试 3 次；sendmessage 判据与文字同三件套。
  async function uploadImage(toUserId, buffer) {
    const aesKey = randomBytes(16);
    const filekey = randomBytes(16).toString('hex');
    const rawsize = buffer.length;
    const rawfilemd5 = createHash('md5').update(buffer).digest('hex');
    const up = expectOk(
      await post('ilink/bot/getuploadurl', {
        filekey,
        media_type: 1, // IMAGE（对齐 SDK UploadMediaType）
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize: aesPaddedSize(rawsize),
        no_need_thumb: true, // 不传缩略图（SDK 同口径）
        aeskey: aesKey.toString('hex'),
        base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
      }),
      'getuploadurl',
    );
    // 实测（2026-10-05 探针，临时文件/probe-upload.mjs）：本机服务端直接回完整预签名 URL
    // `upload_full_url`（CDN 域名 novac2c.cdn.wechat.com）；openilink SDK 样本是 upload_param 自己拼——两种形状都认
    if (!up?.upload_full_url && !up?.upload_param) throw new Error('getuploadurl 未回 upload_full_url/upload_param');
    const ciphertext = encryptAesEcb(buffer, aesKey);
    const cdnUrl = up.upload_full_url
      ?? `${String(凭据.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL).replace(/\/$/, '')}/upload?encrypted_query_param=${encodeURIComponent(up.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
    let downloadParam = null;
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(cdnUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: ciphertext,
        });
        downloadParam = res.headers.get('x-encrypted-param');
        if (res.ok && downloadParam) break;
        if (!downloadParam) {
          const t = await res.text().catch(() => '');
          throw new Error(`CDN HTTP ${res.status} 无 x-encrypted-param（body: ${t.slice(0, 120)}）`);
        }
      } catch (e) {
        lastErr = e;
      }
      if (i < 2) await sleep(2000);
    }
    if (!downloadParam) throw new Error(`CDN 上传失败: ${String(lastErr?.message ?? lastErr)}`);
    return { downloadParam, aesKeyHex: aesKey.toString('hex'), midSize: ciphertext.length };
  }

  // 发图：唯一成功判据 = 返回带 message_id（铁律同文字）；上传一次、发送失败重试 2 次
  async function sendImage(toUserId, filePath, contextToken) {
    let uploaded = null;
    try {
      uploaded = await uploadImage(toUserId, readFileSync(String(filePath)));
    } catch (e) {
      return { ok: false, 错误: `上传失败: ${String(e?.message ?? e)}` };
    }
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const resp = expectOk(
          await post('ilink/bot/sendmessage', {
            msg: {
              from_user_id: '',
              to_user_id: toUserId,
              client_id: randomUUID(),
              message_type: 2,
              message_state: 2,
              ...(contextToken ? { context_token: contextToken } : {}),
              item_list: [{
                type: WX_ITEM_TYPE.IMAGE,
                image_item: {
                  media: {
                    encrypt_query_param: uploaded.downloadParam,
                    aes_key: aesKeyHexToParam(uploaded.aesKeyHex),
                    encrypt_type: ENCRYPT_AES128_ECB,
                  },
                  mid_size: uploaded.midSize,
                },
              }],
            },
            base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
          }),
          'sendImage',
        );
        const mid = findMessageId(resp);
        if (mid != null) return { ok: true, message_id: mid };
        lastErr = new Error('ret:0 但无 message_id（服务端静默丢）');
      } catch (e) {
        lastErr = e;
      }
      if (i < 2) await sleep(3000);
    }
    return { ok: false, 错误: String(lastErr?.message ?? lastErr) };
  }

  return { getUpdates, sendSafe, sendImage, downloadImage, botId };
}

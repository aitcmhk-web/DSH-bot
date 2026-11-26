/**
 * 企微端点 —— 把企微 sidecar 接进 Hub。
 *
 * 设计：协议留在 sidecar（qiwei 桥），插件只认一条本地 HTTP：
 *   入站：sidecar POST /hub/inbound → 本端点 → hub.inbound()
 *   出站：hub.outbound() → 本端点 POST <bridgeUrl>/hub/send → sidecar → 企微
 *
 * ⛔ 不在插件里塞 corpId/secret/AESKey：企微协议、加解密、media/get 都在 sidecar，
 *    插件只做归一消息的搬运。这样主 bot 的配置里不出现第二套企微凭据。
 *
 * 安全：只监听 127.0.0.1；请求必须带共享 token，常量时间比较。
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { makeMessage } from './hub.js';

/** 单条入站 JSON 上限。企微图片 base64 可能接近 10MB，留一倍余量。 */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

/** 出站到 sidecar 的超时。sidecar 只做一次企微 API 调用，正常远小于这个值。 */
const SEND_TIMEOUT_MS = 15_000;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** 常量时间比较；长度不同直接 false（避免 timingSafeEqual 抛错）。 */
function tokenMatches(got, want) {
  const a = Buffer.from(String(got ?? ''), 'utf8');
  const b = Buffer.from(String(want ?? ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 只接受 text / image 块，防止 sidecar 把任意形状塞进 DSH。 */
function sanitizeBlocks(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const block of input.slice(0, 12)) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image' && typeof block.data === 'string') {
      const mediaType = String(block.mediaType ?? block.mimeType ?? 'image/jpeg');
      if (!/^image\/(png|jpe?g|webp|gif)$/i.test(mediaType)) continue;
      out.push({ type: 'image', data: block.data, mediaType });
    }
  }
  return out;
}

export class WecomBridgeEndpoint {
  /**
   * @param {object} options
   * @param {string} options.bridgeUrl sidecar 根地址，如 http://127.0.0.1:8790
   * @param {string} options.token 本地共享 token
   * @param {string} options.userId 企微 owner userid（出站目标）
   * @param {string} [options.host] 入站监听地址，默认 127.0.0.1
   * @param {number} [options.port] 入站监听端口，默认 8793
   * @param {(line:string)=>void} [options.log]
   * @param {(line:string)=>void} [options.error]
   */
  constructor({ bridgeUrl, token, userId, host = '127.0.0.1', port = 8793, log, error }) {
    if (!bridgeUrl) throw new Error('wecomBridgeUrl 不能为空');
    if (!token) throw new Error('wecomBridgeToken 不能为空');
    if (!userId) throw new Error('wecomUserId 不能为空');
    this.id = 'wecom';
    this.bridgeUrl = String(bridgeUrl).replace(/\/$/, '');
    this.token = String(token);
    this.userId = String(userId);
    this.host = host;
    this.port = Number(port);
    this.log = log ?? ((line) => console.log(line));
    this.error = error ?? ((line) => console.error(line));
    this.server = null;
    this.handler = null;
    /** sidecar 重试去重：`${chatId}:${id}` → 时间。 */
    this.seen = new Map();
  }

  /**
   * 启动本地入站 HTTP。失败必须抛出，让 Hub.start() 记成“单端点失败”，
   * 不能影响 TG / 微信继续跑。
   */
  async start(handler) {
    if (this.server) return;
    this.handler = handler;
    this.server = createServer((req, res) => {
      this.#handle(req, res).catch((err) => {
        this.error(`[wecom] 入站处理失败: ${err?.stack ?? err?.message}`);
        if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
        else res.destroy();
      });
    });
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server?.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
    this.log(`[wecom] 入站监听 http://${this.host}:${this.port}/hub/inbound`);
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  /** Hub 出站：把一条归一消息交给 sidecar，由 sidecar 调企微 message/send。 */
  async send(msg) {
    const text = String(msg?.text ?? '');
    if (!text) return;
    const res = await fetch(`${this.bridgeUrl}/hub/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-wecom-token': this.token,
      },
      body: JSON.stringify({ chatId: this.userId, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`企微 sidecar 发送失败 HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
  }

  async #handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${this.host}:${this.port}`);
    if (req.method !== 'POST' || url.pathname !== '/hub/inbound') {
      json(res, 404, { ok: false, error: 'not found' });
      return;
    }
    if (!tokenMatches(req.headers['x-dsh-wecom-token'], this.token)) {
      json(res, 401, { ok: false, error: 'bad token' });
      return;
    }

    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      json(res, 400, { ok: false, error: 'bad json' });
      return;
    }

    const chatId = String(body?.chatId ?? '').trim();
    const text = String(body?.text ?? '').trim();
    const blocks = sanitizeBlocks(body?.blocks);
    if (!chatId || (!text && blocks.length === 0)) {
      json(res, 400, { ok: false, error: 'chatId and text/blocks required' });
      return;
    }

    // sidecar 断线重试可能重复投递：同一个 id 10 分钟内只接一次。
    const messageId = String(body?.id ?? '').trim();
    if (messageId) {
      const key = `${chatId}:${messageId}`;
      const now = Date.now();
      for (const [k, at] of this.seen) {
        if (now - at > 10 * 60 * 1000) this.seen.delete(k);
      }
      if (this.seen.has(key)) {
        json(res, 202, { ok: true, duplicate: true });
        return;
      }
      this.seen.set(key, now);
      if (this.seen.size > 3000) this.seen.delete(this.seen.keys().next().value);
    }

    // 202 立即回 sidecar：DSH 一轮可能跑很久，不能让企微回调等在这里。
    json(res, 202, { ok: true, id: messageId || undefined });
    const msg = makeMessage({
      source: 'wecom',
      chatId,
      text: text || '[图片]',
      raw: { blocks },
    });
    Promise.resolve(this.handler?.(msg)).catch((err) => {
      this.error(`[wecom] 交给 Hub 失败: ${err?.stack ?? err?.message}`);
    });
  }
}

/** 读请求体；超过上限直接拒绝，避免内存被大包打爆。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

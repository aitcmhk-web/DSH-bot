// access.mjs · 通道收发。TG 先做：getUpdates 收、sendMessage 等发；微信第二批
// 铁律：发送唯一成功判据 = 返回带 message_id，HTTP 200 不算数
const TG = 'https://api.telegram.org';

const 类型到接口 = { 文字: 'sendMessage', 图片: 'sendPhoto', 语音: 'sendVoice', 视频: 'sendVideo' };

import { readFileSync } from 'node:fs';
import { markdownToHtml, splitMessageHtml, splitMessageHtmlPlain, splitMessage, htmlIsBalanced } from './md2tg.mjs';

// —— 底层发送：唯一成功判据 = 返回带 message_id（铁律，所有路径共用这一份）——
// payload 可为 JSON 对象（application/json）或 FormData（媒体 multipart 上传）
async function callTG(token, method, payload = {}) {
  const isForm = payload instanceof FormData;
  const r = await fetch(`${TG}/bot${token}/${method}`, {
    method: 'POST',
    headers: isForm ? undefined : { 'content-type': 'application/json' },
    body: isForm ? payload : JSON.stringify(payload),
  });
  const out = await r.json().catch(() => ({}));
  if (!out.ok || !out.result?.message_id) {
    throw new Error(`发送失败：${JSON.stringify(out).slice(0, 300)}`);
  }
  return out;
}

// —— 富文本发送：文字类一律走这里（契约「格式化输出」：两边同格式）——
// 三重保险移植自现役 bot 的 sendRich：
//   ① markdown→HTML 转义 + 标签感知切分  ② 标签不配对 → 整体退纯文本
//   ③ 单块 400 → 只把该块起降级纯文本，前 i 块已成功绝不重发
async function sendRichText(token, chatId, markdown) {
  const parts = splitMessageHtml(markdownToHtml(markdown));
  if (!parts.every((p) => htmlIsBalanced(p))) {
    let last = null;
    for (const p of splitMessage(String(markdown ?? ''))) {
      last = (await callTG(token, 'sendMessage', { chat_id: chatId, text: p })).result.message_id;
    }
    return { message_id: last, mode: 'plain' };
  }
  let lastId = null;
  for (let i = 0; i < parts.length; i++) {
    try {
      lastId = (await callTG(token, 'sendMessage', { chat_id: chatId, text: parts[i], parse_mode: 'HTML' })).result.message_id;
    } catch (err) {
      for (const p of splitMessageHtmlPlain(parts.slice(i))) {
        lastId = (await callTG(token, 'sendMessage', { chat_id: chatId, text: p })).result.message_id;
      }
      return { message_id: lastId, mode: 'plain', fallback: String(err?.message ?? err) };
    }
  }
  return { message_id: lastId, mode: 'html', chunks: parts.length };
}

// send(token, 通道, chatId, 内容) → { message_id }
// 内容: { 类型: 文字|图片|语音|视频, 文件?, 文字? }；媒体填 TG file_id 或 URL
// 文字走富文本（markdown→HTML）；媒体 caption 暂为纯文本
export async function send(token, 通道, chatId, 内容 = {}) {
  if (通道 !== 'tg') throw new Error(`通道未开通：${通道}`);
  if (!token) throw new Error('缺 token');
  const 类型 = 内容.类型 ?? '文字';
  if (类型 === '文字') {
    if (!内容.文字) throw new Error('文字消息缺内容');
    return sendRichText(token, chatId, 内容.文字);
  }
  const method = 类型到接口[类型];
  if (!method) throw new Error(`未知类型：${类型}`);
  if (!内容.文件) throw new Error(`${类型}消息缺文件（file_id 或 URL）`);
  const 字段 = method.replace(/^send/, '').toLowerCase(); // sendPhoto→photo（⚠️ slice(3) 会得 dphoto，别改回去）
  const payload = { chat_id: chatId };
  if (内容.文字) payload.caption = 内容.文字;
  const f = String(内容.文件);
  // 本地路径（项目回传的临时文件）→ multipart 上传；URL / file_id → 直传
  let local = null;
  if (!/^https?:\/\//.test(f)) {
    try { local = readFileSync(f); } catch { /* 不是本地文件，按 file_id 处理 */ }
  }
  if (local) {
    const fd = new FormData();
    fd.append(字段, new Blob([local]), f.split('/').pop()); // 单文件：二进制直接挂字段名
    for (const [k, v] of Object.entries(payload)) fd.append(k, String(v));
    const out = await callTG(token, method, fd);
    return { message_id: out.result.message_id };
  }
  payload[字段] = f;
  const out = await callTG(token, method, payload);
  return { message_id: out.result.message_id };
}

// tg 文件要先 getFile 拿 file_path 才能下载
async function tgFileUrl(token, fileId) {
  const r = await fetch(`${TG}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const out = await r.json().catch(() => ({}));
  if (!out.ok) throw new Error(`getFile 失败：${JSON.stringify(out).slice(0, 200)}`);
  return `${TG}/file/bot${token}/${out.result.file_path}`; // 正确格式：/file/bot<token>/<path>
}

// pollOnce(token, offset?) → { offset, 消息: [标准消息], 失败: [{通道, chatId, 错误}] }
// offset 记在调用方内存里（零数据原则：不落盘）
// 单条消息拉取/归一失败：进「失败」清单并照常推进 offset——坏消息不卡通道、不缓存重试（零数据）
export async function pollOnce(token, offset = 0) {
  const r = await fetch(`${TG}/bot${token}/getUpdates?timeout=0&offset=${offset}`);
  const out = await r.json().catch(() => ({}));
  if (!out.ok) throw new Error(`getUpdates 失败：${JSON.stringify(out).slice(0, 200)}`);
  const { normalize } = await import('../convert/convert.mjs');
  const 消息 = [];
  const 失败 = [];
  let next = offset;
  for (const u of out.result ?? []) {
    next = u.update_id + 1;
    const m = u.message;
    if (!m) continue;
    const base = { 通道: 'tg', chatId: m.chat?.id ?? null, 文字: m.text ?? m.caption ?? '' };
    try {
      if (m.photo) {
        const f = m.photo.at(-1);
        消息.push(await normalize({ ...base, 类型: '图片', 文件URL: await tgFileUrl(token, f.file_id), 文件名: `${f.file_id}.jpg` }));
      } else if (m.voice) {
        消息.push(await normalize({ ...base, 类型: '语音', 文件URL: await tgFileUrl(token, m.voice.file_id), 文件名: `${m.voice.file_id}.ogg` }));
      } else if (m.video) {
        消息.push(await normalize({ ...base, 类型: '视频', 文件URL: await tgFileUrl(token, m.video.file_id), 文件名: `${m.video.file_id}.mp4` }));
      } else if (m.text) {
        消息.push(await normalize({ ...base, 类型: '文字' }));
      }
    } catch (e) {
      console.log(`[pollOnce] 单条消息失败，进失败清单: ${e?.message ?? e}`);
      失败.push({ 通道: base.通道, chatId: base.chatId, 错误: String(e?.message ?? e) });
    }
  }
  return { offset: next, 消息, 失败 };
}

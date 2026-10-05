// api.mjs · 统一调用口：GET /models（不含 key）；POST /call 按名字转发
// 只听 127.0.0.1，不对外网开放
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as registry from '../registry/registry.mjs';

const PORT = Number(process.env.网关端口 ?? 9310);

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((ok, bad) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try { ok(JSON.parse(d || '{}')); } catch (e) { bad(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', bad);
  });
}

// ---------- AITCM 信封适配（2026-10-06）----------
// AITCM 四模块报名字信封 { 项目:'AITCM', 模块:'咨询|舌象|医师|客服', 载荷 } → 查模型表「AITCM·<模块>」条目
// 翻译规则（01-契约「AITCM 信封」节，载荷 100% 透传、不发明内容）：
//   system = 提示词/审查要求/形状说明/修正指令（有哪个拼哪个，\n\n 连接）
//   载荷.图片 {base64,mime} → data URL image_url（放 user 最前）
//   其余字段按出现顺序进 user 文本：字符串原样、对象/数组 JSON 序列化、行首带「字段名：」；chatId 是内部字段不上送
const AITCM_系统字段 = ['提示词', '审查要求', '形状说明', '修正指令'];

function AITCM_翻译(载荷) {
  const p = 载荷 && typeof 载荷 === 'object' ? 载荷 : {};
  const system = AITCM_系统字段
    .filter((k) => typeof p[k] === 'string' && p[k].trim())
    .join('\n\n');
  const 行 = [];
  for (const [k, v] of Object.entries(p)) {
    if (k === 'chatId' || k === '图片' || AITCM_系统字段.includes(k)) continue;
    if (v == null || v === '') continue;
    行.push(`${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  const 图 = p.图片;
  const parts = [];
  if (图 && typeof 图 === 'object' && typeof 图.base64 === 'string' && 图.base64) {
    parts.push({ type: 'image_url', image_url: { url: `data:${图.mime || 'image/jpeg'};base64,${图.base64}` } });
  }
  if (行.length) parts.push({ type: 'text', text: 行.join('\n\n') });
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({
    role: 'user',
    content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
  });
  return messages;
}

export function start() {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/models') {
        return json(res, 200, { 模型: registry.list() });
      }
      if (req.method === 'POST' && req.url === '/call') {
        const body = await readBody(req);
        const 是AITCM信封 = !!body && body.项目 === 'AITCM' && typeof body.模块 === 'string' && !!body.模块;
        let m, 上游体;
        if (是AITCM信封) {
          m = registry.get(`AITCM·${body.模块}`);
          if (!m) return json(res, 400, { 错误: `模型未登记（AITCM·${body.模块}）` });
          const 参数 = m.参数 && typeof m.参数 === 'object' ? { ...m.参数 } : {};
          const model = 参数.model;
          delete 参数.model;
          if (!model) return json(res, 500, { 错误: `表记录 AITCM·${body.模块} 缺 参数.model` });
          上游体 = { model, messages: AITCM_翻译(body.载荷), ...参数 };
        } else {
          m = body?.模型名 ? registry.get(body.模型名) : null;
          if (!m) return json(res, 400, { 错误: '模型未登记' });
          上游体 = body?.输入 ?? {};
        }
        let up;
        try {
          up = await fetch(m.地址, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${m.key ?? ''}` },
            body: JSON.stringify(上游体),
          });
        } catch {
          return json(res, 502, { 错误: '模型不可达', 上游状态: '连接失败' });
        }
        const text = await up.text();
        if (!up.ok) {
          return json(res, 502, { 错误: '模型不可达', 上游状态: up.status, 上游返回: text.slice(0, 500) });
        }
        if (是AITCM信封) {
          try {
            const 原文 = JSON.parse(text)?.choices?.[0]?.message?.content;
            if (typeof 原文 === 'string') return json(res, 200, { 原文 });
          } catch {}
          return json(res, 502, { 错误: '上游响应没有 choices[0].message.content（AITCM 信封要 {原文}）', 上游状态: up.status, 上游返回: text.slice(0, 500) });
        }
        res.writeHead(200, { 'content-type': up.headers.get('content-type') ?? 'application/json; charset=utf-8' });
        return res.end(text); // 原样返回上游输出
      }
      return json(res, 404, { 错误: '无此接口' });
    } catch (e) {
      return json(res, 400, { 错误: String(e?.message ?? e) });
    }
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`模型网关已起：http://127.0.0.1:${PORT}`));
  return server;
}

const isMain =
  process.argv[1] &&
  decodeURIComponent(import.meta.url) === `file://${realpathSync(process.argv[1])}`;
if (isMain) start();

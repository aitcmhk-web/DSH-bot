// api.mjs · 对项目暴露：POST /send 交注册表里的通道适配器发送；GET /health
// 只听 127.0.0.1。/send 要带 token（项目自己的 bot token，它自己知道）
// D12 通道注册制：api 零通道分叉——通道='适配器'，发送器全走注入的查找函数（token+通道 → 适配器）
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.窗口端口 ?? 9320);

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

export function start(送达 = null, 查通道 = null) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/send') {
        const b = await readBody(req);
        const 通道 = b.通道 ?? 'tg'; // 契约：省略通道 = tg（历史项目兼容）
        const 适配器 = 查通道?.(b.token, 通道);
        if (!适配器) throw new Error(`该 token 没起 ${通道} 通道：${b.token}`);
        const 内容 = { 类型: b.类型, 文件: b.文件, 文字: b.文字 };
        const out = await 适配器.发(b.chatId, 内容); // 成功判据 message_id / 失败抛错，都由适配器保证
        送达?.(b.token, 通道, b.chatId); // 回复送达 → 放行该顾客的忙闸门（参数序 token,通道,chatId——旧版错序致放行失效，#18 顺手修）
        return json(res, 200, out);
      }
      return json(res, 404, { 错误: '无此接口' });
    } catch (e) {
      return json(res, 400, { 错误: String(e?.message ?? e) });
    }
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`消息窗口 api 已起：http://127.0.0.1:${PORT}`));
  return server;
}

const isMain =
  process.argv[1] &&
  decodeURIComponent(import.meta.url) === `file://${realpathSync(process.argv[1])}`;
if (isMain) start();

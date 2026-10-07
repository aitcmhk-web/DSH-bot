// api.mjs · 统一调用口：GET /models（不含 key）；POST /call 按名字转发；POST /reload 重读模型表
// 只听 127.0.0.1，不对外网开放
//
// #19 改造（2026-10-07）：模型类型注册制 + 信封注册制 —— 请求解析（信封处理器）与上游调用（类型处理器）
// 全部收进 types/ 注册表，本文件只做装配分发，⛔ 不分叉；对外形状与 2026-10-06 版逐字段一字不改
// （形状红线：主 bot asr.js / 消息窗口 convert.mjs / 插件版转写 / AITCM 四出口都指着这个口）。
// 增减模型 = 改表文件（models.json，key 走 "${ENV名}"）+ POST /reload（现读实现下改表即生效，reload 是主动体检）。
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import * as 注册表 from './types/注册表.mjs';

const registry = 注册表.registry;
// 零硬编码（D5）：监听端口可 env 覆写；缺省 9310 与现网 launchd plist 保持一致（部署可改 env 迁移端口）
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

export function start() {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/models') {
        return json(res, 200, { 模型: registry.list() });
      }
      if (req.method === 'POST' && req.url === '/reload') {
        // 显式重读模型表 + 全量体检（表结构 + 每条 key 的 env 变量是否就位；坏了 500 指名，不静默）
        try {
          const r = registry.reload();
          return json(res, 200, { 重读完成: true, 条数: r.条数, 模型: r.模型 });
        } catch (e) {
          return json(res, 500, { 错误: String(e?.message ?? e) });
        }
      }
      if (req.method === 'POST' && req.url === '/call') {
        const body = await readBody(req);
        // ① 信封注册表：解析请求体（AITCM 报名字信封先认、老直通口兜底），产出模型条目 + 上游请求体
        const 信封 = 注册表.认信封(body);
        const 准 = 信封.准备(body, registry);
        if (准.错误) return json(res, 准.状态码, { 错误: 准.错误 });
        // ② key 解析："${ENV名}" → env 值（缺失 fail-closed 指名报错，D5）；明文兼容旧表过渡期
        let key;
        try {
          key = registry.解析key(准.m);
        } catch (e) {
          return json(res, 400, { 错误: String(e?.message ?? e) });
        }
        // ③ 类型注册表：按条目「类型」字段（缺省 chat）选上游调用协议
        const 类型处理器 = 注册表.条目的类型处理器(准.m);
        const 应答 = await 类型处理器.调用(准.m, 准.上游体, key);
        if (!应答.可达) return json(res, 502, { 错误: '模型不可达', 上游状态: '连接失败' });
        // ④ 信封处理器包装对外响应（形状红线在此锁定）
        return 信封.包装(应答, json, res);
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

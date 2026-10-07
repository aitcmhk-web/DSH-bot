// route.mjs · token→归属项目；把标准消息推给项目接收地址
// 零数据库：只读 config.json；投递失败即时报错、不缓存（零数据的代价，契约写明）
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = join(ROOT, 'config.json');

// 配置可注入（测试用）；不传就读项目根 config.json
export function loadConfig(路径) {
  const file = 路径 ?? CONFIG;
  if (!existsSync(file)) throw new Error('config.json 不存在——从 config.example.json 复制一份再填');
  return JSON.parse(readFileSync(file, 'utf8'));
}

// resolve(token) → 项目名或 null
export function resolve(token, 配置 = loadConfig()) {
  const item = (配置.项目们 ?? []).find((p) => p.token === token);
  return item ? item.项目 : null;
}

// dispatch(标准消息, 配置?) → 项目响应 JSON（含 已回发/回复文本）；失败抛错，不缓存
// 2026-10-06：返回响应体，让上层能发现「已回发:false」（回复没送到顾客）并兜底回显
export async function dispatch(标准消息, 配置 = loadConfig()) {
  const item = (配置.项目们 ?? []).find((p) => p.项目 === 标准消息.项目);
  if (!item?.接收地址) throw new Error(`项目没有登记接收地址：${标准消息.项目}`);
  const r = await fetch(item.接收地址, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(标准消息),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`投递失败：HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}（不缓存，消息丢弃）`);
  return body;
}

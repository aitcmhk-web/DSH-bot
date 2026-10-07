// data.mjs · 数据中转接口（全项目唯一能碰数据库的模块）
// 契约见 01-契约.md：read(表, 条件?) / write(表, 记录)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // modules/data
const ROOT = join(HERE, '..', '..');                  // 项目根
const DB = join(ROOT, '本地数据', 'db.json');

function load() {
  if (!existsSync(DB)) return {};
  return JSON.parse(readFileSync(DB, 'utf8'));
}

function save(db) {
  mkdirSync(dirname(DB), { recursive: true });
  writeFileSync(DB, JSON.stringify(db, null, 2));
}

// 读：read(表, 条件?) → 数组；条件省略返回全部
export function read(表, 条件 = {}) {
  const rows = load()[表] ?? [];
  const kv = Object.entries(条件);
  return rows.filter((r) => kv.every(([k, v]) => r[k] === v));
}

// 写：write(表, 记录) → 落盘后的完整记录（自动带自增 id）
export function write(表, 记录) {
  const db = load();
  const rows = (db[表] ??= []);
  const id = rows.reduce((m, r) => Math.max(m, r.id ?? 0), 0) + 1;
  const row = { id, ...记录 };
  rows.push(row);
  save(db);
  return row;
}

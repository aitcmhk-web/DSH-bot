// registry.mjs · 模型表（配置文件）增删改查；key 只在本项目内流转，绝不外吐
// 表文件：#19 起默认项目根/models.json（随 git；key 一律 "${ENV名}" 引用，⛔ 真 key 不进表不进 git，
//         真值放项目根 .env —— 已 gitignore，launchd 场景由 env文件.mjs 装进 process.env）。
// 兼容：key 字段若不是 "${...}" 引用形状，按明文 key 原样用（旧表 模型表.json 过渡期兼容，形状见 01-契约）。
// 零硬编码（D5）：表文件位置走 env「模型表路径」（相对项目根），缺省 models.json。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { 加载env文件 } from './env文件.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // modules/registry
const ROOT = join(HERE, '..', '..');                  // 项目根
// launchd 环境没有 shell 来源的 env → 启动时把项目根 .env 装进 process.env（已有不覆盖、文件缺了跳过）
加载env文件(join(ROOT, '.env'));
// 表文件位置：env「模型表路径」可绝对可相对（相对项目根）；⛔ 不用 join(ROOT, env值) —— join 对绝对后缀是拼接不是替换（实测踩过：/tmp/x.json 会被拼成 项目根/tmp/x.json）
const TABLE = process.env.模型表路径
  ? (isAbsolute(process.env.模型表路径) ? process.env.模型表路径 : join(ROOT, process.env.模型表路径))
  : join(ROOT, 'models.json');

// key 字段解析："${VAR}" 形状 → process.env[VAR]（缺 → fail-closed 报错并指名）；其余按明文用（旧表兼容）
export function 解析key(记录) {
  const 原值 = 记录?.key ?? '';
  const m = typeof 原值 === 'string' ? 原值.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) : null;
  if (!m) return 原值; // 明文（旧表过渡期）或空串
  const v = process.env[m[1]];
  if (v === undefined || v === '') throw new Error(`模型「${记录.名字}」的 key 引用了 env 变量 ${m[1]}，但该变量未配置（.env 或环境里补上）`);
  return v;
}

function load() {
  if (!existsSync(TABLE)) return [];
  const t = JSON.parse(readFileSync(TABLE, 'utf8'));
  if (!Array.isArray(t)) throw new Error(`模型表不是数组：${TABLE}`);
  for (const m of t) {
    if (!m?.名字 || !m?.地址) throw new Error(`模型表有条目缺 名字/地址：${TABLE}`);
  }
  return t;
}

function save(list) {
  writeFileSync(TABLE, JSON.stringify(list, null, 2));
}

// list → 名字数组（不含 key）
export function list() {
  return load().map((m) => m.名字);
}

// get → 记录或 null（key 只给网关内部转发用）
export function get(名字) {
  return load().find((m) => m.名字 === 名字) ?? null;
}

// 表文件绝对路径（api 的 /reload 报告用）
export function 表路径() {
  return TABLE;
}

// reload：显式重读表文件 + 全量体检（结构 + 每条 key 引用的 env 变量是否就位）。
// 本实现每次 get/list 都现读文件（与现网旧版行为一致，改表即生效），reload 的语义 = 主动体检+确认：
// 全过 → 返回 {条数, 模型}；任一条坏 → 抛错并指名（fail-closed，D5），不静默。
export function reload() {
  const t = load();
  for (const m of t) 解析key(m); // env 缺失会在这里点名抛错
  return { 条数: t.length, 模型: t.map((m) => m.名字) };
}

export function add(记录) {
  if (!记录?.名字 || !记录?.地址) throw new Error('登记模型至少要 名字 + 地址');
  const t = load();
  if (t.some((m) => m.名字 === 记录.名字)) throw new Error(`模型已登记：${记录.名字}`);
  t.push(记录);
  save(t);
  return 记录;
}

export function remove(名字) {
  const t = load();
  const next = t.filter((m) => m.名字 !== 名字);
  if (next.length === t.length) throw new Error(`模型未登记：${名字}`);
  save(next);
  return true;
}

export function update(记录) {
  if (!记录?.名字) throw new Error('更新模型要带 名字');
  const t = load();
  const i = t.findIndex((m) => m.名字 === 记录.名字);
  if (i === -1) throw new Error(`模型未登记：${记录.名字}`);
  t[i] = 记录;
  save(t);
  return 记录;
}

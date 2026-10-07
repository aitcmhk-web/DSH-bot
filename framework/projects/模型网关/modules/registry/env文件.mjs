// env文件.mjs · .env 文件加载器（无第三方依赖）
// 用途：launchd 拉起的进程没有 shell 环境，key 全走 env 变量名引用（models.json 的 "${VAR}" 形状），
//       真值放项目根 .env（已 gitignore，绝不进 git）；系统层/plist 里直接配了 env 的部署不需要 .env。
// 规矩：⛔ 不打印任何值（本模块任何路径都不输出 key/值内容）；已存在的 process.env 不覆盖；
//       文件不存在 = 静默跳过（env 可以来自别处），变量真缺失在 registry 解析 key 时 fail-closed 报错（D5）。
import { existsSync, readFileSync } from 'node:fs';

// 解析 .env 文本 → {名: 值}；只认 KEY=VALUE 行，# 开头注释行跳过，值可带引号
export function 解析env文本(文本) {
  const out = {};
  for (const 原行 of String(文本 ?? '').split(/\r?\n/)) {
    const 行 = 原行.trim();
    if (!行 || 行.startsWith('#')) continue;
    const i = 行.indexOf('=');
    if (i <= 0) continue;
    const 名 = 行.slice(0, i).trim();
    let 值 = 行.slice(i + 1).trim();
    if ((值.startsWith('"') && 值.endsWith('"')) || (值.startsWith("'") && 值.endsWith("'"))) {
      值 = 值.slice(1, -1);
    }
    if (名) out[名] = 值;
  }
  return out;
}

// 加载 .env 到 process.env（不覆盖已有）；返回加载到的变量名数组（只报名字，绝不报值）
export function 加载env文件(路径) {
  if (!existsSync(路径)) return [];
  const 表 = 解析env文本(readFileSync(路径, 'utf8'));
  const 装了 = [];
  for (const [名, 值] of Object.entries(表)) {
    if (process.env[名] === undefined) {
      process.env[名] = 值;
      装了.push(名);
    }
  }
  return 装了;
}

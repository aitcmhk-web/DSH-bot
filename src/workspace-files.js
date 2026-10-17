/**
 * workspace-files.js —— 工作区里的「记忆占位」文件。
 *
 * AGENTS.md 与 memory/lessons-bot.md 是各机器自己的工作区文件：前者是会话开头
 * 注入的要求清单，后者是失败教训档。它们的内容不随包发，也不该由升级覆盖。
 *
 * 这里只做一件事：**文件不存在时建一个空的占位**。已存在的一律不碰 ——
 * 有内容也好、空文件也好，都不动，所以重装 / 升级不会把机器上自己写的记忆冲掉。
 *
 * 为什么放插件里：机器上的升级只走插件这一条路（TG 菜单升级 / setupdsh），
 * 不会重跑安装问答；装在插件里，任何升级路径、任何机器都会得到这两份占位。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 要占位的文件（相对工作区根）。 */
const PLACEHOLDERS = ['AGENTS.md', join('memory', 'lessons-bot.md')];

/**
 * 缺哪个建哪个（空的）。
 *
 * @param {string} cwd 工作区根
 * @param {(msg:string)=>void} [onError] 单个文件建失败时的回调（不影响其它文件）
 */
export function ensureWorkspaceMemoryFiles(cwd, onError) {
  for (const rel of PLACEHOLDERS) {
    const p = join(cwd, rel);
    if (existsSync(p)) continue;
    try {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, '');
    } catch (err) {
      if (onError) onError(`工作区记忆占位没建上（${p}）：${err?.message ?? err}`);
    }
  }
}
/**
 * test-workspace-files.mjs —— 工作区记忆占位回归测试。
 *
 * 覆盖：缺了就建空的；已存在的一律不碰（有内容 / 空文件都一样）；
 * 只缺一个时只补那个；`memory/` 目录不存在时一起建出来。
 *
 * 跑法：node test-workspace-files.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { ensureWorkspaceMemoryFiles } = await import(pathToFileURL(join(HERE, 'src', 'workspace-files.js')).href);

let failed = 0;
const check = (cond, msg) => {
  if (cond) {
    console.log(`✅ ${msg}`);
  } else {
    console.error(`❌ ${msg}`);
    failed += 1;
  }
};
const sizeOf = (p) => statSync(p).size;

const TMP = mkdtempSync(join(tmpdir(), 'wsfiles-test-'));
try {
  // ① 全新工作区：两份都建出来、都是空的
  const errors = [];
  ensureWorkspaceMemoryFiles(TMP, (m) => errors.push(m));
  const agents = join(TMP, 'AGENTS.md');
  const lessons = join(TMP, 'memory', 'lessons-bot.md');
  check(existsSync(agents) && sizeOf(agents) === 0, 'AGENTS.md 建出来了且是空的');
  check(existsSync(lessons) && sizeOf(lessons) === 0, 'memory/lessons-bot.md 建出来了且是空的（memory 目录一起建）');
  check(errors.length === 0, '没有报错');

  // ② 已有内容：再跑一遍一个字都不许动
  writeFileSync(agents, '# 我自己的记忆\n');
  writeFileSync(lessons, '## 第 8 条 · 我自己的教训\n正文\n');
  ensureWorkspaceMemoryFiles(TMP, (m) => errors.push(m));
  check(readFileSync(agents, 'utf8') === '# 我自己的记忆\n', '已有内容的 AGENTS.md 不被覆盖');
  check(readFileSync(lessons, 'utf8').includes('我自己的教训'), '已有内容的 lessons-bot.md 不被覆盖');

  // ③ 只缺一个：补缺的那个，已有的继续不动
  rmSync(lessons);
  ensureWorkspaceMemoryFiles(TMP, (m) => errors.push(m));
  check(existsSync(lessons) && sizeOf(lessons) === 0, '只缺 lessons 时只补它，且是空的');
  check(readFileSync(agents, 'utf8') === '# 我自己的记忆\n', '另一个仍然没有被碰');

  // ④ 空文件也算「已存在」：不重写、不报错
  writeFileSync(agents, '');
  ensureWorkspaceMemoryFiles(TMP, (m) => errors.push(m));
  check(sizeOf(agents) === 0, '空文件不被当成缺失重写');
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} 条用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
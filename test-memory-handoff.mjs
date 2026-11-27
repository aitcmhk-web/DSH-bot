/**
 * test-memory-handoff.mjs —— handoff 三处硬伤的回归测试（2026-11-27 审计后补）。
 *
 * 覆盖：
 *   ① 月初本月只有 2 条：handoff 必须从上月接着取，⛔ 不许只用这 2 条覆盖
 *   ② 原子写：第二次写要留 .prev，且不留 .tmp-* 残渣
 *   ③ 启动补写：ownerUserId 为 null（启动时恒为 null）也要真的写；没新内容则跳过
 *   ④ 账本一条都没有 → ⛔ 不写空壳
 *
 * 跑法：node test-memory-handoff.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Memory } = await import('./src/memory.js');

let 过 = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  过 += 1;
  console.log(`  ✅ ${msg}`);
};
const pad = (n) => String(n).padStart(2, '0');
const 月名 = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const 条目 = (ts, icon, body) => `## ${ts}  ${icon} ${icon === '👤' ? '用户' : '助手'}\n${body}\n`;
const 本地时刻 = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const 睡 = (ms) => new Promise((r) => setTimeout(r, ms));

const 建目录 = (root) => {
  const 账本 = join(root, 'conversation-cache', 'raw', 'ledger');
  mkdirSync(账本, { recursive: true });
  return 账本;
};

const 现在 = new Date();
const 本月 = 月名(现在);
const 上月日 = new Date(现在.getFullYear(), 现在.getMonth() - 1, 1);
const 上月 = 月名(上月日);

// ---------------------------------------------------------------------------
// ① + ② 跨月接续 + 原子写
// ---------------------------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), 'memory-handoff-'));
try {
  const 账本 = 建目录(TMP);

  // 上月 20 条
  let 上月文 = '# 流水账\n\n';
  for (let i = 1; i <= 20; i += 1) {
    上月文 += 条目(`${上月}-05 ${pad(10)}:${pad(i)}:00`, i % 2 ? '👤' : '🤖', `上月-${pad(i)}`);
  }
  writeFileSync(join(账本, `${上月}.md`), 上月文);

  // 本月 2 条
  let 本月文 = '# 流水账\n\n';
  本月文 += 条目(`${本月}-01 09:00:00`, '👤', '本月-01');
  本月文 += 条目(`${本月}-01 09:00:05`, '🤖', '本月-02');
  writeFileSync(join(账本, `${本月}.md`), 本月文);

  const m = new Memory({ memoryDir: TMP, log: () => {}, error: () => {} });
  const 文件 = m.writeHandoff({ sessionId: 's1', reason: 'new', ownerUserId: null, workspace: '/tmp' });
  ok(!!文件 && existsSync(文件), '① handoff 写出来了');

  const 正文 = readFileSync(文件, 'utf8');
  ok(正文.includes('本月-02'), '① 本月最新一条在');
  ok(正文.includes(`上月-${pad(20)}`), '① 上月最后一条也在（跨月接上了）');
  ok(!正文.includes('上月-01'), '① 只取末尾 20 条，上月最早的没有（没把整月都塞进来）');
  const 条数 = (正文.match(/^### /gm) ?? []).length;
  ok(条数 === 20, `① 正好 20 条（实际 ${条数}）`);

  // ② 再写一次：应留 .prev，且不留临时文件
  await 睡(20);
  m.writeHandoff({ sessionId: 's1', reason: 'restart', ownerUserId: null, workspace: '/tmp' });
  ok(existsSync(`${文件}.prev`), '② 第二次写留了 .prev 旧版');
  ok(readFileSync(`${文件}.prev`, 'utf8') === 正文, '② .prev 内容 = 上一版');
  const 残渣 = readdirSync(join(TMP, 'handoff')).filter((f) => f.includes('.tmp-'));
  ok(残渣.length === 0, '② 没有 .tmp-* 残渣');
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// ③ 启动补写：owner 为 null 也要写；没新内容跳过；有新内容再写
// ---------------------------------------------------------------------------
const TMP2 = mkdtempSync(join(tmpdir(), 'memory-boot-'));
try {
  const 账本2 = 建目录(TMP2);
  const 账本文件 = join(账本2, `${本月}.md`);
  writeFileSync(账本文件, '# 流水账\n\n' + 条目(本地时刻(new Date()), '👤', '刚说过的话'));

  const m2 = new Memory({ memoryDir: TMP2, log: () => {}, error: () => {} });
  m2.catchUpHandoffOnBoot({ sessionId: 'boot', ownerUserId: null, workspace: '/tmp' });
  const 文件2 = join(TMP2, 'handoff', 'handoff.md');
  ok(existsSync(文件2), '③ owner=null 时启动补写真执行了');
  ok(readFileSync(文件2, 'utf8').includes('刚说过的话'), '③ 补写内容取自流水账');

  await 睡(20);
  const 改前 = statSync(文件2).mtimeMs;
  m2.catchUpHandoffOnBoot({ sessionId: 'boot', ownerUserId: null, workspace: '/tmp' });
  ok(statSync(文件2).mtimeMs === 改前, '③ 没有新内容 → 跳过，不重复写');

  await 睡(20);
  writeFileSync(账本文件, readFileSync(账本文件, 'utf8') + '\n' + 条目(本地时刻(new Date(Date.now() + 1000)), '👤', '又来一句'));
  m2.catchUpHandoffOnBoot({ sessionId: 'boot', ownerUserId: null, workspace: '/tmp' });
  ok(statSync(文件2).mtimeMs > 改前, '③ 有新内容 → 重新补写');
  ok(readFileSync(文件2, 'utf8').includes('又来一句'), '③ 新内容进了 handoff');
} finally {
  rmSync(TMP2, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// ④ 空账本：⛔ 不写空壳
// ---------------------------------------------------------------------------
const TMP3 = mkdtempSync(join(tmpdir(), 'memory-empty-'));
try {
  const 账本3 = 建目录(TMP3);
  writeFileSync(join(账本3, `${本月}.md`), '# 流水账\n\n');
  const m3 = new Memory({ memoryDir: TMP3, log: () => {}, error: () => {} });
  m3.catchUpHandoffOnBoot({ sessionId: 'boot', ownerUserId: null, workspace: '/tmp' });
  ok(!existsSync(join(TMP3, 'handoff', 'handoff.md')), '④ 空账本不写空壳');
} finally {
  rmSync(TMP3, { recursive: true, force: true });
}

console.log(`\n全部通过：${过} 项`);

/**
 * #35 handoff 裁剪 · 真模块测试（readRecentLedgerEntries / activeTaskSnapshot / capEntryBody）。
 * 数据用真流水账 + 真任务表；反向用例：终态行不得出现、超长必截断、短条不动。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readRecentLedgerEntries,
  activeTaskSnapshot,
  capEntryBody,
  ENTRY_CAP_CHARS,
  ACTIVE_TASK_STATES,
} from './handoff-build.mjs';

const ROOT = new URL('.', import.meta.url).pathname;
let pass = 0;

// 1) capEntryBody：短条原样、长条截断带标记（反向）
const short = capEntryBody('短条', 150);
assert(!short.truncated && short.text === '短条', '短条不得被截断');
const long = capEntryBody('x'.repeat(200), 150);
assert(long.truncated && long.text.length === 150 + '……（截断，全文见流水账 ledger-tail）'.length, '超长必须截断');
assert(long.text.startsWith('x'.repeat(150)), '截断要保头部');
console.log(`capEntryBody ✓ 封顶 ${ENTRY_CAP_CHARS} 字符：短条原样 / 超长截断带指路标记`);
pass++;

// 2) 真流水账：≤20 条、每条 ≤封顶（含标记豁免）、字节数报告
const ledger = readFileSync(join(ROOT, 'memory/conversation-cache/raw/ledger/2026-10.md'), 'utf-8');
const recent = readRecentLedgerEntries(ledger, 20);
const blocks = recent.split(/^### /m).slice(1);
assert(blocks.length > 0 && blocks.length <= 20, `条数应 1..20，实测 ${blocks.length}`);
const marker = '……（截断，全文见流水账 ledger-tail）';
for (const b of blocks) {
  const body = b.split('\n').slice(1).map((l) => l.replace(/^> ?/, '')).join('\n').replaceAll(marker, '');
  const bodyLen = body.trimEnd().length;
  assert(bodyLen <= ENTRY_CAP_CHARS, `反向失守：有条目正文 ${bodyLen} 字符 > ${ENTRY_CAP_CHARS}（前 40 字：${body.slice(0, 40)}）`);
}
const withCut = blocks.filter((b) => b.includes(marker)).length;
console.log(`真流水账 ✓ ${blocks.length} 条全部 ≤${ENTRY_CAP_CHARS} 字符（其中 ${withCut} 条被截断）；输出 ${Buffer.byteLength(recent)}B`);
pass++;

// 3) 条数上限：造 40 条只留 20（反向；条数 20 = 老板 2026-09-16 定死，#35 打回修正锁住）
let synthetic = '# 头\n';
for (let i = 1; i <= 40; i++) {
  synthetic += `## 2026-10-08 00:${String(i % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}  ${i % 2 ? '👤' : '🤖'} ${i % 2 ? '用户' : '助手'}\n条目${i}${'一'.repeat(30)}\n\n`;
}
const s20 = readRecentLedgerEntries(synthetic, 20);
assert(s20.split(/^### /m).length - 1 === 20, `反向失守：应恰好 20 条`);
assert(readRecentLedgerEntries(synthetic).split(/^### /m).length - 1 === 20, '默认参数也必须是 20 条');
assert(s20.includes('条目40一'), '必须取最新一条');
assert(s20.includes('条目21一'), '出局边界内侧：第 21 条必须在场');
assert(!s20.includes('条目20一'), '反向失守：第 20 条（出局边界）不得带进来');
console.log('上限 ✓ 造 40 条只取 20 条，最新在场、第 21 条压线、第 20 条出局（默认参数同验）');
pass++;

// 4) 真任务表：活跃行都在、终态行一个不许进（反向）
const snap = activeTaskSnapshot(join(ROOT, '任务表.md'));
assert(snap.includes('#35'), '快照应含 #35');
const lines = snap.split('\n');
for (const l of lines) {
  assert(/^- #\d+ \[/.test(l), `行形状不对：${l}`);
  const st = l.match(/^- #\d+ \[([^\]]+)\]/)[1];
  assert(ACTIVE_TASK_STATES.includes(st), `反向失守：终态/未知状态 ${st} 混进来了`);
}
assert(!lines.some((l) => l.includes('已发布')), '反向失守：已发布行不得出现');
console.log(`真任务表 ✓ ${lines.length} 条活跃行（待领取/进行中/待验收/验收中/待审核/打回），已发布等终态反向零命中`);
pass++;

// 5) 任务表缺失/为空 → 提示串不抛
assert(activeTaskSnapshot(join(ROOT, '不存在-任务表.md')).includes('任务表不存在'), '缺失要给说明串');
assert(activeTaskSnapshot('/tmp').includes('失败') || activeTaskSnapshot('/tmp').includes('不存在'), '目录路径也要兜住');
console.log('降级 ✓ 任务表缺失/非法路径 → 说明串，不抛异常');
pass++;

// 6) 新旧对比（贴任务表用）：条数同为 20（老板定死），老「不封顶」vs 新「单条封顶」
const oldNoCap = readRecentLedgerEntries(ledger, 20, Infinity);
const newCap = readRecentLedgerEntries(ledger, 20, ENTRY_CAP_CHARS);
console.log(`新旧对比 ✓ 20 条不封顶 = ${Buffer.byteLength(oldNoCap)}B → 20 条封顶 = ${Buffer.byteLength(newCap)}B`);
pass++;

console.log(`\n全部通过：${pass}/6 组用例（含反向）`);

/**
 * run-tests.mjs —— 一条命令跑完所有测试件（`npm test`）。
 *
 * 为什么需要：2026-11-27 审计发现 15 个 test-*.mjs 全靠人记得逐个敲，
 * package.json 里连 scripts 都没有 —— 等于没有回归闸。发版前跑这一条就行。
 *
 * 口径：
 *   · 只跑 `test-*.mjs`；`*-child.mjs` 是别的测试件的子进程夹具，单跑必失败（要端口参数），跳过。
 *   · 逐个串行跑（有的测试会起临时服务/子进程，并行会抢端口）。
 *   · 任何一个非 0 退出即算失败，最后汇总；⛔ 不许「后面过了就把前面红盖掉」。
 *
 * 跑法：npm test   或   node run-tests.mjs
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const 单个超时 = 180_000;

const files = readdirSync(HERE)
  .filter((f) => /^test-.*\.mjs$/.test(f) && !/-child\.mjs$/.test(f))
  .sort();

if (files.length === 0) {
  console.error('⛔ 一个测试件都没找到');
  process.exit(1);
}

const 失败 = [];
const 起 = Date.now();
console.log(`共 ${files.length} 个测试件\n`);

for (const f of files) {
  console.log(`\n▶ ${f}`);
  const r = spawnSync(process.execPath, [join(HERE, f)], { stdio: 'inherit', timeout: 单个超时 });
  if (r.status !== 0) {
    失败.push(f);
    console.error(`✗ ${f} 失败（${r.status === null ? '超时/被信号杀掉' : `退出码 ${r.status}`}）`);
  }
}

const 秒 = ((Date.now() - 起) / 1000).toFixed(1);
console.log(`\n${'─'.repeat(40)}`);
if (失败.length === 0) {
  console.log(`✅ ${files.length} 个测试件全过（${秒}s）`);
  process.exit(0);
}
console.log(`❌ ${失败.length}/${files.length} 个失败（${秒}s）：`);
for (const f of 失败) console.log(`   · ${f}`);
process.exit(1);

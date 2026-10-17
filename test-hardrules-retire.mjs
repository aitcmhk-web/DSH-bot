/**
 * test-hardrules-retire.mjs —— setupdsh 里 hard-rules 退役逻辑的回归测试。
 *
 * 直接从 setupdsh.sh 抽出 strip_legacy_hardrules / retire_legacy_hardrules 两个函数，
 * 在临时 DSH_HOME 上跑真函数（不是复刻算法），覆盖踩过的形状：
 *   ① 文件是 `[]` + 块（两个 YAML 文档叠一起）→ 退役后只剩一个 `[]`；
 *   ② `- insert:` 和条目之间夹空行 → 不能留下没有条目的空壳 `- insert:`；
 *   ③ 块上面还有别的 insert → 只删块，别的原样；
 *   ④ 没有这个块的文件 → 一个字节都不动；
 *   ⑤ 文件只有这个块 → 退役后是 `[]`。
 *
 * 跑法：node test-hardrules-retire.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'setupdsh.sh'), 'utf8');

/** 从 setupdsh.sh 里抽一个「到行首 } 为止」的函数体（抽不到就报错，别退化成正则空跑）。 */
function grabFn(re, name) {
  const hit = re.exec(SRC);
  if (!hit) throw new Error(`从 setupdsh.sh 抽不到 ${name} —— 函数名或结构变了`);
  return hit[0];
}
const STRIP_FN = grabFn(/^HARD_RULES_MARK=[^\n]*\n[\s\S]*?\n\}\n/m, 'strip_legacy_hardrules');
const RETIRE_FN = grabFn(/^retire_legacy_hardrules\(\)[\s\S]*?\n\}\n/m, 'retire_legacy_hardrules');

const BLOCK = '- insert:\n    - id: hard-rules\n      name: "file:///Users/tcm/DSH/hard-rules/index.mjs"\n';
const OTHER = '- insert:\n    - id: some-other\n      name: foo\n';

/** 一条用例：{ 文件名、原始内容、断言 }。 */
const CASES = [
  {
    name: '把 [] 和块叠一起的坏文件修成只留一个 []',
    file: 't-empty-then-block',
    text: `[]\n\n# ── hard-rules 段 ──\n${BLOCK}`,
    check: (out) => out === '[]\n',
  },
  {
    name: 'insert 与条目之间夹空行也不留空壳 insert',
    file: 't-blank-in-shell',
    text: `${OTHER}\n- insert:\n\n    - id: hard-rules\n      name: "file:///Users/tcm/DSH/hard-rules/index.mjs"\n`,
    check: (out) => out === OTHER && !/-\s*insert:\s*\n\s*$/m.test(out),
  },
  {
    name: '同文件里别的 insert 原样保留，只删 hard-rules 块',
    file: 't-keep-others',
    text: `${OTHER}\n# ── hard-rules 段 ──\n${BLOCK}`,
    check: (out) => out.includes('some-other') && !out.includes('hard-rules'),
  },
  {
    name: '没有这个块的文件一个字节都不动',
    file: 't-none',
    text: OTHER,
    check: (out, before) => out === before,
  },
  {
    name: '文件只有这个块 → 退役后是 []',
    file: 't-only-block',
    text: `# hard-rules 说明\n${BLOCK}`,
    check: (out) => out === '[]\n',
  },
];

let failed = 0;
const check = (cond, msg) => {
  if (cond) {
    console.log(`✅ ${msg}`);
  } else {
    console.error(`❌ ${msg}`);
    failed += 1;
  }
};

const TMP = mkdtempSync(join(tmpdir(), 'hardrules-retire-'));
try {
  const dshHome = join(TMP, '.dsh');
  for (const c of CASES) {
    mkdirSync(join(dshHome, 'profiles', c.file), { recursive: true });
    writeFileSync(join(dshHome, 'profiles', c.file, 'cordis.patch.yml'), c.text);
  }
  // 原始内容留档：用来判「该没动的没动」
  const before = new Map(CASES.map((c) => [c.file, c.text]));

  const harness = join(TMP, 'harness.sh');
  writeFileSync(harness, `say() { echo "$@"; }\n${STRIP_FN}\n${RETIRE_FN}\nretire_legacy_hardrules\n`);
  execFileSync('sh', [harness], { env: { ...process.env, DSH_HOME: dshHome }, stdio: 'pipe' });

  for (const c of CASES) {
    const out = readFileSync(join(dshHome, 'profiles', c.file, 'cordis.patch.yml'), 'utf8');
    check(c.check(out, before.get(c.file)), c.name);
  }
  // 备份必须落下来（可回滚）
  const backups = execFileSync('sh', ['-c', `ls ${join(dshHome, 'profiles')}/*/cordis.patch.yml.bak-hardrules-retired-* 2>/dev/null | wc -l`]).toString().trim();
  check(Number(backups) === 4, `落下的备份数 = 4（改了 4 个文件，没改的不备份）：${backups}`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} 条用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
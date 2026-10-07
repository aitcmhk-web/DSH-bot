/**
 * #35 小工注入瘦身 · 生成器测试（跑的是真实模块，不是复制的算法）。
 * 用例含反向：marker 缺失不写不设、master 零动作、切片反向不含门五~九。
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWorkerInstructionSlice,
  syncWorkerInstructions,
  WORKER_SLICE_MARKER,
  WORKER_INSTRUCTIONS_FILE,
} from './worker-instructions.mjs';

const ROOT = new URL('.', import.meta.url).pathname;
const agentsPath = join(ROOT, 'AGENTS.md');
const agents = readFileSync(agentsPath, 'utf-8');
const outFile = join(ROOT, WORKER_INSTRUCTIONS_FILE);
let pass = 0;

// 0) 前置：AGENTS.md 必须真有门五（否则下面的反向断言全是空转）
assert(agents.includes(`\n${WORKER_SLICE_MARKER}`), '前置失败：AGENTS.md 里找不到门五标记');
console.log(`前置 ✓ AGENTS.md 含门五标记（全文 ${Buffer.byteLength(agents)}B）`);

// 1) 切片成功 + 门一~四/第 29/30 条都在 + 反向：门五~九一个都不能有
const cut = buildWorkerInstructionSlice(agents);
assert(cut.ok, `切片应成功：${cut.reason ?? ''}`);
for (const head of ['# 门一、', '# 门二、', '# 门三、', '# 门四、', '## 第 29 条', '## 第 30 条']) {
  assert(cut.slice.includes(head), `切片应含 ${head}`);
}
for (const head of ['# 门五、', '# 门六、', '# 门七、', '# 门八、', '# 门九、']) {
  assert(!cut.slice.includes(head), `反向失守：切片里混进了 ${head}`);
}
console.log(`切片 ✓ 门一~四+第29/30条都在；门五~九反向零命中（${Buffer.byteLength(cut.slice)}B / 全量 ${Buffer.byteLength(agents)}B）`);
pass++;

// 2) marker 缺失 → ok:false，不抛异常
assert(buildWorkerInstructionSlice('这里没有任何门标记').ok === false, '无标记应 ok:false');
assert(buildWorkerInstructionSlice('').ok === false, '空文本应 ok:false');
console.log('反向 ✓ marker 缺失/空文本 → ok:false 不抛异常');
pass++;

// 3) master 零动作：不生成、不设 env（在真 ROOT 上跑也不会碰文件）
delete process.env.DSH_WORKER_INSTRUCTIONS;
rmSync(outFile, { force: true });
const m = syncWorkerInstructions({ root: ROOT, role: 'master', log: () => {}, logErr: () => {} });
assert(m.generated === false && m.envSet === false, 'master 不得生成/设 env');
assert(!existsSync(outFile), '反向失守：master 跑完不该出现切片文件');
assert(process.env.DSH_WORKER_INSTRUCTIONS === undefined, '反向失守：master 不得设 DSH_WORKER_INSTRUCTIONS');
console.log('主 bot 零改动 ✓ master 角色不生成文件、不设 env（反向验证通过）');
pass++;

// 4) worker 角色：生成文件 + 设 env + 文件内容即切片（横幅除外）
const w = syncWorkerInstructions({ root: ROOT, role: 'worker', log: () => {}, logErr: () => {} });
assert(w.generated === true && w.envSet === true, 'worker 应生成并设 env');
assert(process.env.DSH_WORKER_INSTRUCTIONS === '1', 'env 应为 1');
assert(existsSync(outFile), '切片文件应存在');
const onDisk = readFileSync(outFile, 'utf-8');
assert(onDisk.includes('权威源 = AGENTS.md'), '应有防手改横幅');
assert(onDisk.includes('## 第 30 条'), '存在性检查：文件须能答「第 30 条讲了什么」（条目必须在）');
assert(!onDisk.includes('# 门五、'), '反向失守：落盘文件不得含门五');
console.log(`worker ✓ ${WORKER_INSTRUCTIONS_FILE} 落盘（${Buffer.byteLength(onDisk)}B）+ env 已设；第 30 条在场、门五反向零命中`);
pass++;

// 5) 失败降级：假 root 没有 AGENTS.md → 不生成、不设 env、不落文件
const fakeRoot = mkdtempSync(join(tmpdir(), '#35-noagents.'));
delete process.env.DSH_WORKER_INSTRUCTIONS;
const f = syncWorkerInstructions({ root: fakeRoot, role: 'worker', log: () => {}, logErr: () => {} });
assert(f.generated === false && f.envSet === false, '失败应降级为不生成不设 env');
assert(!existsSync(join(fakeRoot, WORKER_INSTRUCTIONS_FILE)), '失败不得落文件');
assert(process.env.DSH_WORKER_INSTRUCTIONS === undefined, '失败不得残留 env');
console.log('降级 ✓ AGENTS.md 缺失 → 不生成、不设 env（小工回退全量，绝不裸奔）');
pass++;

console.log(`\n全部通过：${pass}/5 组用例（含 3 组反向）`);

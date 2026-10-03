#!/usr/bin/env node
/**
 * sync-model-blocks.mjs 回归测试。⛔ 只在临时目录里跑，绝不动真配置。
 * 判据按 AGENTS.md 第 22 条：照着「真配置」写，并做反向验证（守卫失效必须变红）。
 */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  utimesSync,
  readdirSync,
  existsSync,
  chmodSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  syncOnce,
  startWatch,
  loadAuthority,
  saveAuthority,
  blockOf,
  norm,
  nonManagedSignature,
  applyBlocks,
  unifiedDiff,
  MANAGED_BLOCKS,
} from './sync-model-blocks.mjs';

let pass = 0;
let fail = 0;
const pending = [];
function t(name, fn) {
  pending.push([name, fn]);
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '不相等'}\n      期望: ${JSON.stringify(b)}\n      实际: ${JSON.stringify(a)}`);
}
function ok(v, msg) {
  if (!v) throw new Error(msg || '期望为真');
}

// ────────────────────────── 夹具 ──────────────────────────

const WEB_FIXTURE = `# web patch —— 前导注释必须逐字保留
# 第二行注释
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      alibailian:
        displayName: 阿里百炼
        apiKeyEnv: ALIBAILIAN_API_KEY
        baseURL: https://example.invalid/compatible-mode/v1
        models:
          - id: qwen3.7-flash
            name: qwen3.7-flash
            contextWindow: 1000000
            maxTokens: 32768

- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    baseURL: https://api.deepseek.com/anthropic

- id: agent-preset-registry
- id: ui-chat
  config:
    transcriptView: compact
- id: ui-settings
  config:
    enabled: false
`;

const DESKTOP_FIXTURE = `# desktop patch —— 前导注释必须逐字保留
- id: ui-chat
  config:
    transcriptView: verbose
- id: ui-settings
  config:
    enabled: true
- id: ui-settings-account
# ⚠️ 手写段：同步必须原样保留
#    实现 /Users/tcm/DSH/hard-rules/index.mjs
- insert:
    - id: hard-rules
      name: "file:///Users/tcm/DSH/hard-rules/index.mjs"
`;

const T0 = Date.now() - 3600_000;

function writeAt(path, text, mtimeMs) {
  writeFileSync(path, text);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

function scenario({ web = WEB_FIXTURE, desktop = DESKTOP_FIXTURE, webAt = T0, desktopAt = T0 - 60_000, authority = null, authorityAt = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'modelsync-'));
  const webPath = join(dir, 'web.yml');
  const desktopPath = join(dir, 'desktop.yml');
  const authPath = join(dir, 'models-authority.json');
  writeAt(webPath, web, webAt);
  writeAt(desktopPath, desktop, desktopAt);
  if (authority) {
    saveAuthority(authPath, authority);
    if (authorityAt) utimesSync(authPath, authorityAt / 1000, authorityAt / 1000);
  }
  const log = [];
  const cfg = { targets: [{ label: 'web', path: webPath }, { label: 'desktop', path: desktopPath }], authorityPath: authPath };
  return {
    dir,
    webPath,
    desktopPath,
    authPath,
    log,
    read: (p) => readFileSync(p, 'utf8'),
    auth: () => loadAuthority(authPath),
    run: (opts = {}) => syncOnce({ ...cfg, log: (s) => log.push(s), ...opts }),
  };
}

// ────────────────────────── 用例 ──────────────────────────

t('① 首次同步：网页端的两个模型块整块复制进桌面端，网页端一字不动', () => {
  const s = scenario();
  s.run();
  eq(s.read(s.webPath), WEB_FIXTURE, '网页端必须逐字未变');
  const d = s.read(s.desktopPath);
  for (const id of MANAGED_BLOCKS) {
    ok(blockOf(d, id), `桌面端缺 ${id}`);
    eq(norm(blockOf(d, id).text), norm(blockOf(WEB_FIXTURE, id).text), `${id} 内容必须与网页端一致`);
  }
  const a = s.auth();
  eq(Object.keys(a.blocks).sort().join(','), 'llm-deepseek,llm-pi-ai', '权威源应记两条');
  eq(a.blocks['llm-pi-ai'].updatedAt, T0, '权威源时间戳应取网页端 mtime');
});

t('② 非托管部分逐字未变（前导注释 / 其它块 / 手写 hard-rules 段）', () => {
  const s = scenario();
  s.run();
  eq(nonManagedSignature(s.read(s.desktopPath)), nonManagedSignature(DESKTOP_FIXTURE), '桌面端非托管签名必须不变');
  ok(s.read(s.desktopPath).includes('file:///Users/tcm/DSH/hard-rules/index.mjs'), '手写 hard-rules 段必须还在');
  ok(s.read(s.desktopPath).includes('transcriptView: verbose'), '桌面端的 verbose 必须还在');
  ok(s.read(s.desktopPath).includes('enabled: true'), '桌面端的 enabled: true 必须还在');
});

t('③ 再跑一次 = no-op（两边一致 → 不写盘、不抖）', () => {
  const s = scenario();
  s.run();
  const dBefore = statSync(s.desktopPath);
  const aBefore = statSync(s.authPath);
  const r = s.run();
  eq(r.decisions.length, 0, '不应有决策');
  eq(r.writes.length, 0, '不应有写入');
  eq(statSync(s.desktopPath).mtimeMs, dBefore.mtimeMs, '桌面端不应被重写');
  eq(statSync(s.authPath).mtimeMs, aBefore.mtimeMs, '权威源不应被重写');
});

t('④ 反向：桌面端较新的改动广播回网页端', () => {
  const s = scenario();
  s.run();
  const edited = s.read(s.desktopPath).replace('maxTokens: 32768', 'maxTokens: 65536').replace('qwen3.7-flash\n            name', 'qwen3.7-flash\n            name');
  writeAt(s.desktopPath, edited, T0 + 10_000);
  s.run();
  ok(s.read(s.webPath).includes('maxTokens: 65536'), '网页端应收到桌面端的改动');
  eq(s.auth().blocks['llm-pi-ai'].updatedAt, T0 + 10_000, '权威源应更新为桌面端 mtime');
  eq(nonManagedSignature(s.read(s.webPath)), nonManagedSignature(WEB_FIXTURE), '网页端非托管部分必须不变');
});

t('⑤ 只有一边有的块：缺失方补上（⛔ 不传播删块）', () => {
  const s = scenario();
  s.run();
  const wiped = s.read(s.webPath).replace(/^- id: llm-pi-ai[\s\S]*?(?=\n- id: llm-deepseek)/m, '').replace(/\n\n- id: llm-deepseek/, '\n- id: llm-deepseek');
  ok(!blockOf(wiped, 'llm-pi-ai'), '夹具本身应已删掉该块');
  writeAt(s.webPath, wiped, T0 + 20_000);
  s.run();
  ok(blockOf(s.read(s.webPath), 'llm-pi-ai'), '被删的块必须补回来');
  ok(blockOf(s.read(s.desktopPath), 'llm-pi-ai'), '桌面端应保持有');
  eq(s.auth().blocks['llm-pi-ai'].updatedAt, T0, '权威源不应因单边删块而变化');
});

t('⑥ 两端都删了 → 权威源也删（⛔ 不无限复活）', () => {
  const s = scenario();
  s.run();
  const cut = (txt) =>
    txt.replace(/^- id: llm-deepseek[\s\S]*?(?=\n- id: )/m, '').replace(/\n\n- id: agent-preset-registry/, '\n- id: agent-preset-registry');
  const w = cut(s.read(s.webPath));
  const d = cut(s.read(s.desktopPath));
  ok(!blockOf(w, 'llm-deepseek') && !blockOf(d, 'llm-deepseek'), '夹具应已两边都删');
  writeAt(s.webPath, w, T0 + 30_000);
  writeAt(s.desktopPath, d, T0 + 30_000);
  s.run();
  eq(s.auth().blocks['llm-deepseek'], undefined, '权威源应删掉该条');
  ok(!blockOf(s.read(s.webPath), 'llm-deepseek'), '不应复活到网页端');
  ok(!blockOf(s.read(s.desktopPath), 'llm-deepseek'), '不应复活到桌面端');
});

t('⑦ 冲突：两端都改 → mtime 新的赢，日志点名另一方', () => {
  const s = scenario();
  s.run();
  writeAt(s.webPath, s.read(s.webPath).replace('maxTokens: 32768', 'maxTokens: 11111'), T0 + 40_000);
  writeAt(s.desktopPath, s.read(s.desktopPath).replace('maxTokens: 32768', 'maxTokens: 22222'), T0 + 50_000);
  s.run();
  ok(s.read(s.webPath).includes('maxTokens: 22222'), '桌面端（较新）应赢');
  eq(s.auth().blocks['llm-pi-ai'].updatedAt, T0 + 50_000, '权威源应取较新的一侧');
  ok(s.log.join('\n').includes('同时改的还有 web'), '日志必须点名被覆盖的一方');
});

t('⑧ 界面偏好块不互相覆盖（compact vs verbose 各留各的）', () => {
  const s = scenario();
  s.run();
  ok(s.read(s.webPath).includes('transcriptView: compact'), '网页端 compact 应保留');
  ok(s.read(s.desktopPath).includes('transcriptView: verbose'), '桌面端 verbose 应保留');
  const sig = nonManagedSignature(s.read(s.desktopPath));
  ok(!MANAGED_BLOCKS.includes('ui-chat'), 'ui-chat 不应在托管白名单里');
  eq(sig, nonManagedSignature(DESKTOP_FIXTURE), '签名应仍与原文一致');
});

t('⑨ 原子写：不留 .tmp、权限保持、备份只留一份', () => {
  const s = scenario();
  chmodSync(s.desktopPath, 0o600);
  chmodSync(s.webPath, 0o640);
  s.run();
  const files = readdirSync(s.dir);
  eq(files.filter((f) => f.includes('.modelsync-') && f.endsWith('.tmp')).length, 0, '不许留 .tmp 残骸');
  eq(statSync(s.desktopPath).mode & 0o777, 0o600, '桌面端权限应保持 600');
  eq(statSync(s.webPath).mode & 0o777, 0o640, '网页端权限应保持 640');
  const baks = files.filter((f) => f.includes('.bak.modelsync-'));
  eq(baks.length, 1, '本进程每文件只备份一次（桌面端被写，网页端没被写）');
  s.run();
  eq(readdirSync(s.dir).filter((f) => f.includes('.bak.modelsync-')).length, 1, '再跑一轮不应新增备份');
});

t('⑩ dryRun 不写盘（文件与权威源都不动），并打印 diff', () => {
  const s = scenario();
  const before = { w: statSync(s.webPath).mtimeMs, d: statSync(s.desktopPath).mtimeMs };
  const r = s.run({ dryRun: true });
  eq(s.read(s.desktopPath), DESKTOP_FIXTURE, 'dry-run 不许改文件');
  eq(s.read(s.webPath), WEB_FIXTURE, 'dry-run 不许改网页端');
  eq(existsSync(s.authPath), false, 'dry-run 不许写权威源');
  eq(statSync(s.webPath).mtimeMs, before.w);
  eq(statSync(s.desktopPath).mtimeMs, before.d);
  ok(r.writes.length > 0, 'dry-run 仍应算出要改什么');
  eq(readdirSync(s.dir).filter((f) => f.includes('.bak.modelsync-')).length, 0, 'dry-run 不许备份');
});

t('⑪ 反向验证：守卫有效（非托管块被删 → 签名必变），坏权威源必须拒绝', () => {
  const dropped = DESKTOP_FIXTURE.replace('# ⚠️ 手写段：同步必须原样保留\n', '');
  ok(nonManagedSignature(dropped) !== nonManagedSignature(DESKTOP_FIXTURE), '签名必须能发现「少了东西」');
  const s = scenario();
  s.run();
  writeFileSync(s.authPath, '{ 这不是 JSON');
  let threw = null;
  try {
    s.run();
  } catch (err) {
    threw = err;
  }
  ok(threw && /不是合法 JSON/.test(threw.message), '坏权威源必须抛错（⛔ 不允许拿坏文件去覆盖 profile）');
});

t('⑫ 空数组占位 `[]` 能被补块顶掉，注释照样保留', () => {
  const s = scenario({ desktop: '# 桌面端补丁\n[]\n' });
  s.run();
  const d = s.read(s.desktopPath);
  ok(d.includes('# 桌面端补丁'), '前导注释必须保留');
  ok(!/^\[\]$/m.test(d), '`[]` 占位必须被删掉');
  eq(blockOf(d, 'llm-pi-ai') && blockOf(d, 'llm-deepseek') ? 'both' : 'missing', 'both');
});

t('⑬ 真配置的副本上跑一次：只新增两个模型块，其余逐字一致', () => {
  const webReal = join(process.env.HOME, '.dsh', 'profiles', 'web', 'cordis.patch.yml');
  const deskReal = join(process.env.HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  ok(existsSync(webReal) && existsSync(deskReal), '真配置文件必须存在');
  const dir = mkdtempSync(join(tmpdir(), 'modelsync-real-'));
  const webPath = join(dir, 'web.yml');
  const deskPath = join(dir, 'desktop.yml');
  const authPath = join(dir, 'auth.json');
  copyFileSync(webReal, webPath);
  copyFileSync(deskReal, deskPath);
  const deskBefore = readFileSync(deskPath, 'utf8');
  const webBefore = readFileSync(webPath, 'utf8');
  const log = [];
  syncOnce({
    targets: [{ label: 'web', path: webPath }, { label: 'desktop', path: deskPath }],
    authorityPath: authPath,
    log: (l) => log.push(l),
    env: { MODELSYNC_NO_BACKUP: '1' },
  });
  eq(readFileSync(webPath, 'utf8'), webBefore, '网页端真配置副本必须逐字未变');
  const after = readFileSync(deskPath, 'utf8');
  eq(nonManagedSignature(after), nonManagedSignature(deskBefore), '桌面端真配置副本的非托管部分必须逐字未变');
  for (const id of MANAGED_BLOCKS) {
    ok(blockOf(after, id), `桌面端副本应新增 ${id}`);
    eq(norm(blockOf(after, id).text), norm(blockOf(webBefore, id).text), `${id} 应与网页端真配置一致`);
  }
  ok(after.includes('file:///Users/tcm/DSH/hard-rules/index.mjs'), '手写 hard-rules 段必须还在');
  ok(after.includes('transcriptView: verbose'), '桌面端 verbose 必须还在');
  ok(after.includes('provider: deepseek-account'), '桌面端 agent-default-model 必须还在');
  const added = after.split('\n').length - deskBefore.split('\n').length;
  ok(added > 60 && added < 80, `行数增量应在 60~80，实际 ${added}`);
});

t('⑮ 测试防呆：MODELSYNC_DISABLE=1 时 startWatch 绝不启动（⛔ 不许测到真配置）', () => {
  const s = scenario();
  const prev = process.env.MODELSYNC_DISABLE;
  process.env.MODELSYNC_DISABLE = '1';
  let timer = 'x';
  try {
    timer = startWatch({ targets: [{ label: 'web', path: s.webPath }, { label: 'desktop', path: s.desktopPath }], authorityPath: s.authPath, log: (l) => s.log.push(l) });
  } finally {
    if (prev === undefined) delete process.env.MODELSYNC_DISABLE;
    else process.env.MODELSYNC_DISABLE = prev;
  }
  eq(timer, null, '必须返回 null（没起定时器）');
  eq(s.read(s.desktopPath), DESKTOP_FIXTURE, '⛔ 不许写桌面端');
  eq(existsSync(s.authPath), false, '⛔ 不许写权威源');
  ok(s.log.join('\n').includes('已按 MODELSYNC_DISABLE=1 停用'), '必须留下停用日志');
});

t('⑭ diff 输出能看出「少了什么」', () => {
  const d = unifiedDiff('a\nb\nc', 'a\nc', 'x');
  ok(d.includes('-b'), 'diff 必须标出被删的行');
});

// ────────────────────────── 跑 ──────────────────────────

console.log('sync-model-blocks 回归测试（权威源 + 广播）');
for (const [name, fn] of pending) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

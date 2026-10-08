/**
 * 回归测试：插件版自愈 `src/model-sync.js`（2026-10-09）
 *
 * 复现的 bug（用户报障）：web 里加了 provider → 插件菜单看得见（菜单读 web 的 patch），
 * 但本 profile 的 `cordis.patch.yml` 没有它 → 一选就
 * `❌ no adapter registered for provider "xiaomi-token-plan-cn"`。
 * 修法：插件启动时把 web 的模型块**只增不改不删**地补齐进本 profile。
 *
 * 反向判据（第 22 条：测试要照着真实校验写、并能复现旧 bug）：
 *   - 旧行为（不补）→ 断言「beta 出现在本 profile」必然变红；
 *   - 补的方式必须是**并集**：本地独有 provider 保留、原有行一行不动、非托管部分一字不改。
 *
 * 全程用临时目录里的合成 patch，⛔ 不碰真 `~/.dsh`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syncOwnProfileFromWeb, mergeAdditive, detectOwnProfileDir } from './src/model-sync.js';
import { blockOf, nonManagedSignature, norm } from './sync-model-blocks.mjs';

const WEB_PATCH = `[]
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      alpha:
        models:
          - id: a-1
            name: A1
        apiKeyEnv: ALPHA_KEY
      beta:
        models:
          - id: b-1
            name: B1
            contextWindow: 1234
        apiKeyEnv: BETA_KEY
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    baseURL: https://api.deepseek.com/anthropic
`;

// 本 profile：有 alpha（应一字不动）、有 web 没有的 mine（应保留）、缺 beta、缺整个 llm-deepseek
const SELF_PATCH = `[]
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      alpha:
        models:
          - id: a-1
            name: A1
        apiKeyEnv: ALPHA_KEY
      mine:
        models:
          - id: m-1
            name: M1
        apiKeyEnv: MINE_KEY
- id: keep-me
  config:
    note: 非托管块，谁都不许动
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pluginsync-test-'));
  const webDir = join(root, 'profiles', 'web');
  const selfDir = join(root, 'profiles', 'dshbot');
  mkdirSync(webDir, { recursive: true });
  mkdirSync(selfDir, { recursive: true });
  writeFileSync(join(webDir, 'cordis.patch.yml'), WEB_PATCH);
  writeFileSync(join(selfDir, 'cordis.patch.yml'), SELF_PATCH);
  return {
    root,
    env: { HOME: root, DSH_HOME: root },
    webPath: join(webDir, 'cordis.patch.yml'),
    selfDir,
    patchPath: join(selfDir, 'cordis.patch.yml'),
    read: () => readFileSync(join(selfDir, 'cordis.patch.yml'), 'utf8'),
  };
}

const lines = (s) => s.split('\n');
/**
 * old 的每一行都必须按原顺序出现在 next 里（= 没有任何一行被改写或删除）。
 * 唯一豁免：空 profile 的 `[]` 占位 —— 插入真块时它必须让位（sync-model-blocks.mjs 的
 * `applyBlocks` 就是这么写的），这是唯一一处「删除」，且删的是空数组标记不是配置。
 */
function assertNoLineChanged(oldText, newText) {
  const hay = lines(newText);
  let i = 0;
  for (const line of lines(oldText)) {
    if (line.trim() === '[]') continue;
    const at = hay.indexOf(line, i);
    assert.notEqual(at, -1, `原有行被改动或删除：${JSON.stringify(line)}`);
    i = at + 1;
  }
}

test('① 复现旧 bug：web 有 beta / 本 profile 没有 → 同步后补齐（旧行为必红）', () => {
  const f = fixture();
  assert.ok(!f.read().includes('beta:'), '前置：本 profile 本来就没有 beta');
  const r = syncOwnProfileFromWeb({ profileDir: f.selfDir, webPath: f.webPath, env: f.env });
  assert.equal(r.action, 'written');
  assert.deepEqual(r.blocks, ['llm-pi-ai', 'llm-deepseek']);
  const after = f.read();
  assert.ok(after.includes('beta:'), 'beta 必须补进来');
  assert.ok(after.includes('b-1'));
  assert.ok(after.includes('contextWindow: 1234'));
  assert.ok(after.includes('BETA_KEY'));
  assert.ok(after.includes('- id: llm-deepseek'), '整个 llm-deepseek 块要补进来');
});

test('② 只增不改不删：原有行一行不动，本地独有 provider 保留', () => {
  const f = fixture();
  syncOwnProfileFromWeb({ profileDir: f.selfDir, webPath: f.webPath, env: f.env });
  assertNoLineChanged(SELF_PATCH, f.read());
  assert.ok(f.read().includes('mine:'), '本地独有 provider 必须保留');
  assert.ok(f.read().includes('MINE_KEY'));
});

test('③ 非托管部分逐字节不变', () => {
  const f = fixture();
  syncOwnProfileFromWeb({ profileDir: f.selfDir, webPath: f.webPath, env: f.env });
  assert.equal(nonManagedSignature(f.read()), nonManagedSignature(SELF_PATCH));
  assert.ok(f.read().includes('note: 非托管块，谁都不许动'));
});

test('④ 缩进正确：补进来的子树按父节点缩进差量平移', () => {
  const f = fixture();
  syncOwnProfileFromWeb({ profileDir: f.selfDir, webPath: f.webPath, env: f.env });
  const b = blockOf(f.read(), 'llm-pi-ai');
  assert.ok(b, 'llm-pi-ai 块还在');
  const text = b.lines.join('\n');
  assert.match(text, /^ {6}beta:$/m, 'provider 键必须落在 6 空格');
  assert.match(text, /^ {10}- id: b-1$/m, 'model 项必须落在 10 空格');
  assert.match(text, /^ {8}apiKeyEnv: BETA_KEY$/m);
});

test('⑤ 幂等 + 定点：再跑一次零写入（in-sync），合并结果再合一次不变', () => {
  const f = fixture();
  syncOwnProfileFromWeb({ profileDir: f.selfDir, webPath: f.webPath, env: f.env });
  const once = f.read();
  const r2 = syncOwnProfileFromWeb({ profileDir: f.selfDir, webPath: f.webPath, env: f.env });
  assert.equal(r2.action, 'in-sync');
  assert.equal(f.read(), once, '第二次必须一个字节都不写');
  for (const id of ['llm-pi-ai', 'llm-deepseek']) {
    const w = blockOf(WEB_PATCH, id);
    const s = blockOf(once, id);
    assert.ok(w && s, `${id} 两侧都应有块`);
    assert.equal(norm(mergeAdditive(s.lines, w.lines).join('\n')), norm(s.lines.join('\n')), `${id} 必须是不动点`);
  }
});

test('⑥ 绝不写 web：源文件与 profile=web 都必须被跳过', () => {
  const f = fixture();
  const webBefore = readFileSync(f.webPath, 'utf8');
  syncOwnProfileFromWeb({ profileDir: f.selfDir, webPath: f.webPath, env: f.env });
  assert.equal(readFileSync(f.webPath, 'utf8'), webBefore, 'web 是源，一个字节都不许动');
  const r = syncOwnProfileFromWeb({ profileDir: join(f.root, 'profiles', 'web'), webPath: f.webPath, env: f.env });
  assert.equal(r.action, 'is-web');
  assert.equal(readFileSync(f.webPath, 'utf8'), webBefore);
});

test('⑦ 本地整块缺失 → 整块插入，且不破坏已有非托管块', () => {
  const root = mkdtempSync(join(tmpdir(), 'pluginsync-noblock-'));
  const selfDir = join(root, 'profiles', 'tui');
  mkdirSync(selfDir, { recursive: true });
  writeFileSync(join(selfDir, 'cordis.patch.yml'), '[]\n\n- id: my-thing\n  config:\n    x: 1\n');
  const webPath = join(root, 'web.yml');
  writeFileSync(webPath, WEB_PATCH);
  const r = syncOwnProfileFromWeb({ profileDir: selfDir, webPath, env: { HOME: root, DSH_HOME: root } });
  assert.equal(r.action, 'written');
  const after = readFileSync(join(selfDir, 'cordis.patch.yml'), 'utf8');
  assert.match(after, /- id: llm-pi-ai/);
  assert.match(after, /- id: llm-deepseek/);
  assert.match(after, /- id: my-thing/);
  assert.ok(after.includes('x: 1'));
  assert.ok(!after.includes('[]'), '[] 占位必须被换成真块');
});

test('⑧ MODELSYNC_DISABLE=1 全面停用（测试 spawn 真 DSH 时的护栏）', () => {
  const f = fixture();
  const before = f.read();
  const r = syncOwnProfileFromWeb({ profileDir: f.selfDir, webPath: f.webPath, env: { ...f.env, MODELSYNC_DISABLE: '1' } });
  assert.equal(r.action, 'disabled');
  assert.equal(f.read(), before);
  assert.equal(readdirSync(f.selfDir).filter((n) => n.includes('bak')).length, 0);
});

test('⑨ MODELSYNC_NO_BACKUP=1 → 不落备份；默认落 .bak.pluginsync-<时间戳>', () => {
  const a = fixture();
  syncOwnProfileFromWeb({ profileDir: a.selfDir, webPath: a.webPath, env: { ...a.env, MODELSYNC_NO_BACKUP: '1' } });
  assert.equal(readdirSync(a.selfDir).filter((n) => n.includes('bak')).length, 0);
  const b = fixture();
  syncOwnProfileFromWeb({ profileDir: b.selfDir, webPath: b.webPath, env: b.env });
  const baks = readdirSync(b.selfDir).filter((n) => n.includes('.bak.pluginsync-'));
  assert.equal(baks.length, 1, '默认必须落一份备份');
  assert.equal(readFileSync(join(b.selfDir, baks[0]), 'utf8'), SELF_PATCH, '备份必须是改动前的内容');
});

test('⑩ web 缺失 / 无 patch → 报明确状态，不写任何东西', () => {
  const f = fixture();
  assert.equal(syncOwnProfileFromWeb({ profileDir: f.selfDir, webPath: join(f.root, 'nope.yml'), env: f.env }).action, 'no-web');
  assert.equal(syncOwnProfileFromWeb({ profileDir: join(f.root, 'nope-profile'), webPath: f.webPath, env: f.env }).action, 'no-patch');
  assert.equal(syncOwnProfileFromWeb({ profileDir: null, webPath: f.webPath, env: f.env }).action, 'no-profile');
  assert.equal(f.read(), SELF_PATCH);
});

test('⑪ dryRun 只报不改', () => {
  const f = fixture();
  const r = syncOwnProfileFromWeb({ profileDir: f.selfDir, webPath: f.webPath, env: f.env, dryRun: true });
  assert.equal(r.action, 'would-write');
  assert.equal(f.read(), SELF_PATCH);
});

test('⑫ 反推 profile 目录：安装布局 <profile>/node_modules/dsh-botplugin/src/ → <profile>', () => {
  const root = mkdtempSync(join(tmpdir(), 'pluginsync-detect-'));
  const pkgSrc = join(root, 'profiles', 'dshbot', 'node_modules', 'dsh-botplugin', 'src');
  mkdirSync(pkgSrc, { recursive: true });
  const fakeSelf = join(pkgSrc, 'model-sync.js');
  writeFileSync(fakeSelf, '// x\n');
  assert.equal(detectOwnProfileDir({ selfFile: fakeSelf, env: { HOME: root, DSH_HOME: root } }), join(root, 'profiles', 'dshbot'));
  // 仓库内直接跑（没有 node_modules 祖先）→ 返回 null 或本机某 profile，绝不抛异常
  assert.doesNotThrow(() => detectOwnProfileDir({ selfFile: join(process.cwd(), 'src', 'model-sync.js'), env: { HOME: '/nonexistent-home-xyz' } }));
});

test('⑬ 接线防回归：apply() 里必须真的调了 syncOwnProfileFromWeb，且失败被隔离', () => {
  const src = readFileSync(new URL('./src/index.js', import.meta.url), 'utf8');
  assert.match(src, /^import \{ syncOwnProfileFromWeb \} from '\.\/model-sync\.js';$/m, 'import 必须在');
  const at = src.indexOf('export function apply(ctx, config) {');
  assert.notEqual(at, -1);
  const body = src.slice(at, at + 2000);
  assert.match(body, /syncOwnProfileFromWeb\(\{/, 'apply() 里必须真的调用');
  assert.match(body, /try \{[\s\S]*syncOwnProfileFromWeb[\s\S]*\} catch \(err\) \{/, '必须用 try/catch 隔离，⛔ 不许让同步失败拖垮插件启动');
});

test('⑭ 包体契约：sync-model-blocks.mjs 必须在 files 白名单里（否则装完 import 就炸）', () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('sync-model-blocks.mjs'), 'sync-model-blocks.mjs 必须在 files 里');
  assert.ok(existsSync(new URL('./sync-model-blocks.mjs', import.meta.url)));
});

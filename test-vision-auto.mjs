/**
 * 回归测试：识图探测脚本 `vendor/vision-auto.mjs`。
 *
 * 真跑脚本（不复制它的算法），用临时 HOME + 本地假端点覆盖三件事：
 *   ① 目标发现：`profiles/<档名>/cordis.patch.yml` 里声明过模型的**每一份**都要处理。
 *      只认 `profiles/web` 是不够的 —— bot 用的那份（provider 注册在它身上）
 *      不改，识图照样不通。
 *   ② 复测翻案：服务商声明了 `defaultInput: [text, image]`，模型条目却还盖着旧
 *      `input: [text]` → 探测通过必须摘掉旧标记（标记是粘的，不摘就永久关掉识图）。
 *   ③ 不乱标记 / 不假成功：报错**没提图片**（如模型名写错）时不许插 `input: [text]`；
 *      没有可处理的配置时退出码必须是 3（「跳过」不能被调用方记成「完成」）。
 *
 * 跑法：node botplugin/test-vision-auto.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'vision-auto.mjs');

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) failed++;
};

/** 云端那台的真实形状：服务商声明识图，模型条目上盖着旧「纯文字」标记。 */
const patch = (baseURL, modelId, mark) => `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      zhipu:
        apiKeyEnv: ZHIPU_API_KEY
        api: openai-completions
${baseURL ? `        baseURL: ${baseURL}\n` : ''}        defaultInput:
          - text
          - image
        models:
          - id: ${modelId}
            name: ${modelId}${mark ? '\n            input:\n              - text' : ''}
- id: llm-deepseek
  config:
    reasoningEffort: off
    models:
      - id: deepseek-flash
        name: DeepSeek-V41-Flash
`;

// ── 本地假端点：只回答 /chat/completions，不碰真实服务商 ──────────────────
let mode = 'ok';
let hits = 0;
const server = createServer((req, res) => {
  hits += 1;
  if (mode === 'ok') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"OK"}}]}');
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"model not found: check the id"}}');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE_URL = `http://127.0.0.1:${server.address().port}/`;

/** 造一个临时 HOME：两个 profile 各一份模型配置（bot 用的 + web 的）。 */
function makeHome({ mark = true, profiles = ['mybot', 'web'], baseURL = BASE_URL } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vision-auto-test-'));
  for (const name of profiles) {
    const dir = join(home, '.dsh', 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cordis.patch.yml'), patch(baseURL, 'glm-4.7-flash', mark));
  }
  return home;
}

// ⚠️ 必须异步 spawn：假端点在**本进程**里跑，同步 spawnSync 会把事件循环堵死，
//    端点答不上话 → 每次探测都等满超时 → 用例假绿（这正是本文件第一版的坑）。
const run = (home) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, HOME: home } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

const readPatch = (home, name) =>
  readFileSync(join(home, '.dsh', 'profiles', name, 'cordis.patch.yml'), 'utf8');

// ── 用例 1：两份配置都要处理，旧标记都要摘掉 ──────────────────────────────
{
  const home = makeHome({ mark: true });
  hits = 0;
  const r = await run(home);
  ok(hits === 1, `同一「服务商+模型」只探一次，不随 profile 数倍增（实际请求 ${hits} 次）`);
  ok(r.status === 0, `两份配置都跑完（退出码 ${r.status}）`);
  const groups = (r.stdout.match(/^────/gm) ?? []).length;
  ok(groups === 2, `发现并处理了两个 profile 的文件（分组数 ${groups}）`);
  for (const name of ['mybot', 'web']) {
    const text = readPatch(home, name);
    ok(!/^\s+input:/m.test(text), `${name}：旧「纯文字」标记已摘掉`);
    const dir = join(home, '.dsh', 'profiles', name);
    ok(readdirSync(dir).some((f) => f.includes('.bak.visionauto-')), `${name}：写回前留了备份`);
  }
  ok(r.stdout.includes('官方 DeepSeek 档/deepseek-flash'), '官方 DeepSeek 档被点名（不再只字不提）');
  rmSync(home, { recursive: true, force: true });
}

// ── 用例 2：报错没提图片 → 不许插标记 ────────────────────────────────────
{
  mode = 'textoops';
  const home = makeHome({ mark: false });
  const r = await run(home);
  for (const name of ['mybot', 'web']) {
    ok(!/^\s+input:/m.test(readPatch(home, name)),
      `${name}：报错与图片无关时没有被打上「纯文字」`);
  }
  ok(r.stdout.includes('未知'), '结论按「未知」报告（不猜、不写）');
  mode = 'ok';
  rmSync(home, { recursive: true, force: true });
}

// ── 用例 3：没有可处理的配置 → 退出码 3（跳过 ≠ 完成） ────────────────────
{
  const home = mkdtempSync(join(tmpdir(), 'vision-auto-empty-'));
  const r = await run(home);
  ok(r.status === 3, `空 HOME 退出码 3（实际 ${r.status}）`);
  ok((r.stderr ?? '').includes('跳过识图探测'), '空 HOME 明确报「跳过」');
  rmSync(home, { recursive: true, force: true });
}

// ── 用例 4：服务商没写 baseURL（本地 llama.cpp 一类）→ 不探测、不崩 ──────
{
  const home = makeHome({ mark: false, baseURL: '' });
  const r = await run(home);
  ok(r.status === 0, `没 baseURL 也不崩（退出码 ${r.status}）`);
  ok(r.stdout.includes('服务商没写 baseURL'), '如实报「没 baseURL，不探测」');
  ok(!/^\s+input:/m.test(readPatch(home, 'mybot')), '没乱插标记');
  rmSync(home, { recursive: true, force: true });
}

server.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
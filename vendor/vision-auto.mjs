#!/usr/bin/env node
/**
 * vision-auto.mjs —— 识图能力全自动探测 + 标记。
 *
 * 设计（2026-09-28 与用户定的方案）：
 *   「假设所有模型都有识图」= 服务商级 defaultInput: [text, image]（本脚本负责补齐）
 *   「第一次运行时判断并做标识」= 真发一张测试图给每个模型：
 *       通  → 不动（继承 defaultInput，自动识图）
 *       不通 → 在该模型条目下精确插入 `input: [text]` 标记（标记优先级最高）
 *       未知（网络/鉴权/超时）→ 不动，只报告
 *
 * 依据：dsh-llm-ai 模态回退链 = 模型 input → 服务商 defaultInput → 默认 ["text"]。
 * key 来源：~/.dsh/.credentials.yaml 的 refs（DSH 凭据层），本地服务免 key。
 *
 * 用法：
 *   node vision-auto.mjs                 # 探测 + 标记真文件
 *   node vision-auto.mjs --check         # 只探测报告，不写文件
 *   node vision-auto.mjs --force         # 已标记的模型也重新探测（不自动删旧标记，仅报告）
 *   node vision-auto.mjs --quiet         # 静默（bot 启动钩子用），只报错误
 *   node vision-auto.mjs <file>          # 指定目标文件（副本试跑）
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const HOME = homedir();
const target = process.argv.slice(2).find((a) => !a.startsWith('-')) || `${HOME}/.dsh/settings.yaml`;
const CHECK = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');
const QUIET = process.argv.includes('--quiet');

const say = (msg) => { if (!QUIET) console.log(msg); };
const require2 = createRequire(join(HOME, '.dsh/profiles/node_modules/'));
const YAML = require2('yaml');

/** 1x1 红色 PNG。 */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TIMEOUT_MS = 15000;

function loadKeys() {
  try {
    const doc = YAML.parse(readFileSync(`${HOME}/.dsh/.credentials.yaml`, 'utf8'));
    return doc?.refs ?? {};
  } catch {
    return {};
  }
}

/** 探测单个模型是否接受图片。返回 'vision' | 'no' | 'unknown'。 */
async function probe(baseURL, apiKeyEnv, modelId, keys) {
  const url = baseURL.replace(/\/+$/, '') + '/chat/completions';
  const key = keys[apiKeyEnv];
  const headers = { 'Content-Type': 'application/json' };
  const isLocal = /localhost|127\.0\.0\.1/.test(baseURL);
  if (key && key !== 'local') headers.Authorization = `Bearer ${key}`;
  else if (!isLocal && !key) return { verdict: 'unknown', why: '找不到 key' };

  const body = {
    model: modelId,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG}` } },
        { type: 'text', text: 'Reply with the single word OK' },
      ],
    }],
    max_tokens: 20,
  };
  try {
    const res = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { verdict: 'vision' };
    if ([400, 404, 422].includes(res.status)) return { verdict: 'no', why: `HTTP ${res.status}` };
    return { verdict: 'unknown', why: `HTTP ${res.status}` };
  } catch (e) {
    return { verdict: 'unknown', why: e.name === 'TimeoutError' ? '超时' : e.message };
  }
}

/** 在文件文本中定位某模型条目的行区间，返回 {start, end}（含首含尾，0 基）。
 *  条目 = 精确匹配的 `        - id: <id>` 行 + 其后所有 ≥10 空格缩进的从属行。
 *  （0/4/6 空格的行——顶层键、provider 键、4 空格列表——一律不算条目成员。） */
function findEntry(lines, modelId) {
  const idLine = `        - id: ${modelId}`;
  const start = lines.indexOf(idLine);
  if (start === -1) return null;
  let end = start;
  for (let i = start + 1; i < lines.length && /^ {10,}/.test(lines[i]); i++) end = i;
  return { start, end };
}

const entryHasInput = (lines, r) => lines.slice(r.start, r.end + 1).some((l) => /^ {8,}input:/.test(l));

async function main() {
  const src = readFileSync(target, 'utf8');
  const doc = YAML.parse(src);
  const providers = doc?.['llm-pi-ai']?.providers ?? {};
  const keys = loadKeys();
  const lines = src.split('\n');

  // ── 第 1 步：确保每个服务商都有 defaultInput（「假设都有识图」层）──
  const INJECT = '      defaultInput:\n        - text\n        - image\n';
  let changed = false;
  for (const [name, p] of Object.entries(providers)) {
    if (p?.defaultInput?.includes('image')) continue;
    const anchor = src.match(new RegExp(`^      baseURL: ${p.baseURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`, 'm'));
    if (!anchor) { say(`⚠️ ${name}: 找不到 baseURL 锚点，跳过 defaultInput`); continue; }
    if (CHECK) { say(`（将给 ${name} 补 defaultInput）`); continue; }
    lines.splice(lines.findIndex((l) => l === `      baseURL: ${p.baseURL}`) + 1, 0, ...INJECT.trimEnd().split('\n'));
    changed = true;
    say(`✅ ${name}: 已补 defaultInput [text, image]`);
  }
  // 重新按（可能已变的）行集工作
  const work = lines;

  // ── 第 2 步：逐模型探测（并发）──
  const jobs = [];
  for (const [name, p] of Object.entries(providers)) {
    for (const m of p?.models ?? []) {
      const r = findEntry(work, m.id);
      if (!r) { jobs.push({ name, id: m.id, run: null, note: '找不到条目' }); continue; }
      if (entryHasInput(work, r) && !FORCE) {
        jobs.push({ name, id: m.id, run: null, note: '已有标记，跳过（--force 重测）' });
        continue;
      }
      jobs.push({ name, id: m.id, entry: r, run: probe(p.baseURL, p.apiKeyEnv, m.id, keys) });
    }
  }
  await Promise.all(jobs.map(async (j) => {
    if (!j.run) return;
    j.result = await j.run;
  }));

  // ── 第 3 步：汇总；为「不通」的模型插入 `input: [text]` 标记 ──
  const marks = [];
  for (const j of jobs) {
    if (!j.run) { say(`⏭ ${j.name}/${j.id}: ${j.note}`); continue; }
    const v = j.result.verdict;
    if (v === 'vision') say(`✅ ${j.name}/${j.id}: 识图正常`);
    else if (v === 'no') {
      marks.push(j);
      say(`⛔ ${j.name}/${j.id}: 不支持识图（${j.result.why}）→ 将标记纯文字`);
    } else say(`⚠️ ${j.name}/${j.id}: 未知（${j.result.why}）→ 不动`);
  }
  marks.sort((a, b) => b.entry.start - a.entry.start); // 从后往前插，行号不失效
  for (const j of marks) {
    if (CHECK) continue;
    work.splice(j.entry.end + 1, 0, '          input:', '            - text');
    changed = true;
  }

  if (CHECK) { say('（--check 未写文件）'); return; }
  if (!changed) { say('无改动。'); return; }
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const backup = `${target}.bak.visionauto-${ts}`;
  copyFileSync(target, backup);
  writeFileSync(target, work.join('\n'));
  say(`\n✅ 已写回 ${target}（备份：${backup}）。重启 bot 后生效。`);
}

main().catch((e) => { console.error('⛔ vision-auto 失败:', e.message); process.exit(1); });

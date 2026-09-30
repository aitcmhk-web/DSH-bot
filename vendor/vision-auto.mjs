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
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const HOME = homedir();
/**
 * 目标文件（默认）：web 端「设置 → 模型」的真实落盘。
 *
 * ⚠️ 路径变迁（2026-09-30 实证）：
 *   - 0.2.0 起 home 级 `~/.dsh/settings.yaml` 被升级流程**搬走**
 *     （只剩 `settings.yaml.imported`），web 端配置改落
 *     `profiles/web/cordis.patch.yml`；
 *   - 老代码默认写死 settings.yaml → 每次都走「未找到 → 跳过探测」，
 *     识图标记永远补不上（2026-09-30 远端实测报的就是这条）。
 *   ⇒ 默认优先 patch，不存在再退回 settings.yaml（老版本 DSH 仍可用）。
 *   显式传参（副本试跑）优先级最高，不受影响。
 */
const CANDIDATES = [
  `${HOME}/.dsh/profiles/web/cordis.patch.yml`,
  `${HOME}/.dsh/settings.yaml`,
];
const argTarget = process.argv.slice(2).find((a) => !a.startsWith('-'));
const target = argTarget
  || CANDIDATES.find((p) => { try { return existsSync(p); } catch { return false; } })
  || CANDIDATES[0];
const CHECK = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');
const QUIET = process.argv.includes('--quiet');

const say = (msg) => { if (!QUIET) console.log(msg); };

/** YAML 解析器，main() 里赋值；两处解析都失败时保持 null（调用方明确跳过，绝不崩）。 */
let YAML = null;

/**
 * 拿 YAML 解析器，两步：
 *   ① 正路 —— 作为包依赖解析（插件正确装好依赖时，或脚本目录向上能走到 node_modules/yaml）；
 *   ② 兼容本机 DSH 安装 —— ~/.dsh/profiles/node_modules 里常备 yaml（DSH 全家桶）。
 * 都拿不到返回 null —— 只跳过，绝不崩（2026-09-29：老写法硬编码 ②，别的机器上启动即崩）。
 */
async function loadYaml() {
  try {
    return await import('yaml');
  } catch {}
  try {
    return createRequire(join(HOME, '.dsh/profiles/node_modules/'))('yaml');
  } catch {}
  return null;
}

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
 *
 *  ⚠️ 缩进**不能写死**（2026-09-30 实测踩过）：模型条目的缩进取决于它嵌在哪：
 *    settings.yaml   顶层 map      → `        - id:`（8 空格）
 *    cordis.patch.yml 顶层数组+config → `          - id:`（10 空格）
 *  写死 8 空格的话，patch 文件里 indexOf 恒为 -1 —— 每个模型都「找不到条目」，
 *  静默什么都不做。所以这里按 `- id: <id>` 的实际缩进匹配，并据此推算从属行缩进。 */
function findEntry(lines, modelId) {
  const re = new RegExp(`^(\\s*)- id: ${modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  let start = -1;
  let indent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) { start = i; indent = m[1].length; break; }
  }
  if (start === -1) return null;
  // 从属行 = 比条目行缩进更深的后续行
  let end = start;
  const deeper = new RegExp(`^ {${indent + 1},}`);
  for (let i = start + 1; i < lines.length && deeper.test(lines[i]); i++) end = i;
  return { start, end, indent };
}

const entryHasInput = (lines, r) => lines.slice(r.start, r.end + 1).some((l) => /^\s*input:/.test(l));

/** 摘掉条目里的纯文字标记（input: 行 + 紧随的 - text 行）。从区间尾部往前删，行号不失效。 */
function removeMark(lines, r) {
  for (let i = r.end; i >= r.start; i--) {
    if (/^\s*input:/.test(lines[i])) {
      lines.splice(i, /^\s*- /.test(lines[i + 1] ?? '') ? 2 : 1);
    }
  }
}

async function main() {
  YAML = await loadYaml();
  if (!YAML) {
    // ⚠️ 用 console.log 而非 say()：跳过原因即使在 --quiet 下也要留痕。
    console.log('⏭ 没有 YAML 解析器（插件依赖未安装，本机也没有 DSH 自带的）—— 跳过识图探测。');
    return;
  }
  let src;
  try {
    src = readFileSync(target, 'utf8');
  } catch {
    console.log(`⏭ 未找到 ${target}（web 端未配模型）—— 跳过识图探测。`);
    return;
  }
  const doc = YAML.parse(src);
  // ── 取 providers：两种顶层结构都要认 ──────────────────────────────
  //   settings.yaml   → 顶层 map，`llm-pi-ai` 是顶层键；
  //   cordis.patch.yml→ 顶层 **数组**，llm-pi-ai 是其中一条 `- id: llm-pi-ai`
  //                     条目，providers 在它的 `config:` 下面。
  //   ⚠️ 只认 map 的话，patch 文件会静默拿到 {} —— provider 全丢、一个都不探测。
  const piEntry = Array.isArray(doc)
    ? doc.find((e) => e?.id === 'llm-pi-ai')
    : doc?.['llm-pi-ai'];
  const providers = piEntry?.config?.providers ?? piEntry?.providers ?? {};
  const keys = loadKeys();
  const lines = src.split('\n');

  // ── 第 1 步：确保每个服务商都有 defaultInput（「假设都有识图」层）──
  //   ⚠️ 缩进按 baseURL 行**实测**推算（defaultInput 与 baseURL 同级，其列表项再深 2），
  //      不写死 6 空格 —— patch 文件里是 8，写死就注错层、YAML 直接坏掉。
  let changed = false;
  for (const [name, p] of Object.entries(providers)) {
    if (p?.defaultInput?.includes('image')) continue;
    const esc = String(p.baseURL ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!esc) { say(`⚠️ ${name}: 无 baseURL，跳过 defaultInput`); continue; }
    const anchorRe = new RegExp(`^(\\s*)baseURL: ["']?${esc}["']?\\s*$`, 'm');
    const anchor = src.match(anchorRe);
    if (!anchor) { say(`⚠️ ${name}: 找不到 baseURL 锚点，跳过 defaultInput`); continue; }
    if (CHECK) { say(`（将给 ${name} 补 defaultInput）`); continue; }
    const pad = anchor[1];
    const INJECT = [`${pad}defaultInput:`, `${pad}  - text`, `${pad}  - image`];
    const at = lines.findIndex((l) => new RegExp(`^${pad}baseURL: ["']?${esc}["']?\\s*$`).test(l));
    if (at === -1) { say(`⚠️ ${name}: 行定位失败，跳过 defaultInput`); continue; }
    lines.splice(at + 1, 0, ...INJECT);
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

  // ── 第 3 步：汇总；「不通」插标记 / --force 复测翻案的摘旧标记 ──
  const ops = [];
  for (const j of jobs) {
    if (!j.run) { say(`⏭ ${j.name}/${j.id}: ${j.note}`); continue; }
    const v = j.result.verdict;
    const hasMark = j.entry ? entryHasInput(work, j.entry) : false;
    if (v === 'vision') {
      if (hasMark && FORCE) {
        // 复测翻案：原来标了纯文字、现在通了 —— 不摘旧标记就永远用不上识图。
        ops.push({ pos: j.entry.end, entry: j.entry, kind: 'remove' });
        say(`🔄 ${j.name}/${j.id}: 复测识图正常 → 摘除旧纯文字标记`);
      } else say(`✅ ${j.name}/${j.id}: 识图正常`);
    } else if (v === 'no') {
      if (hasMark) {
        // ⛔ 2026-09-29 远端实爆修复：--force 复测「仍不支持」时条目里已有 input:，
        //    老代码不查重再插一次 = 重复键 = 整份 settings.yaml 变非法 YAML。
        say(`⏭ ${j.name}/${j.id}: 仍不支持，维持原标记（不重复插入）`);
        continue;
      }
      // input 与条目内其它键（id/name）同级：比 `- ` 再深 2，实测条目缩进推算。
      const p2 = ' '.repeat((j.entry.indent ?? 8) + 2);
      ops.push({ pos: j.entry.end + 1, kind: 'insert', pad: p2 });
      say(`⛔ ${j.name}/${j.id}: 不支持识图（${j.result.why}）→ 将标记纯文字`);
    } else say(`⚠️ ${j.name}/${j.id}: 未知（${j.result.why}）→ 不动`);
  }
  ops.sort((a, b) => b.pos - a.pos); // 从后往前，行号不失效
  for (const op of ops) {
    if (CHECK) continue;
    if (op.kind === 'insert') work.splice(op.pos, 0, `${op.pad}input:`, `${op.pad}  - text`);
    else removeMark(work, op.entry);
    changed = true;
  }

  if (CHECK) { say('（--check 未写文件）'); return; }
  if (!changed) { say('无改动。'); return; }
  // ⛔ 最后一道闸：写回前必须能整体重新解析成合法 YAML，解析不过一字不写。
  //   （settings.yaml 坏一份 = providers/permission 全丢，2026-09-29 远端实爆过一回。）
  try {
    YAML.parse(work.join('\n'));
  } catch (err) {
    console.error(`⛔ 生成的 YAML 解析失败（${err.message}）—— 已放弃写回，原文件未动。`);
    process.exit(1);
  }
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const backup = `${target}.bak.visionauto-${ts}`;
  copyFileSync(target, backup);
  writeFileSync(target, work.join('\n'));
  say(`\n✅ 已写回 ${target}（备份：${backup}）。重启 bot 后生效。`);
}

main().catch((e) => { console.error('⛔ vision-auto 失败:', e.message); process.exit(1); });

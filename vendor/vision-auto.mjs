#!/usr/bin/env node
/**
 * vision-auto.mjs —— 识图能力全自动探测 + 标记。
 *
 * 设计：
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
 *
 * 默认目标 = 所有声明过 `llm-pi-ai` / `llm-deepseek` 的 `profiles/<档名>/cordis.patch.yml`
 * （老版 DSH 才用 home 级 settings.yaml）。
 * 退出码：0 = 已处理；3 = 没找到可处理的配置（跳过）；1 = 失败。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
/**
 * 要处理的文件（默认）：**所有声明过模型**的 profile patch。
 *
 * ⚠️ 只认 `profiles/web` 那份是不够的：`llm-pi-ai` 的模型块要落两份 ——
 *    本 profile 那份决定 provider 注册（真正管「图发不发得出去」的是它），
 *    web 那份只管菜单。只改 web ⇒ bot 用的那份还带着「纯文字」旧标记，
 *    识图照样不通。所以这里逐个 profile 扫，谁的 patch 里有
 *    `- id: llm-pi-ai` / `llm-deepseek` 段就处理谁。
 *
 * ⚠️ 0.2.0 起 home 级 `~/.dsh/settings.yaml` 被升级流程搬走，只在老版本 DSH 上
 *    还作后备（上面一份都没找到时才用它）。
 *
 * ⚠️ 一个都没有时**不能报成功**：调用方按退出码记日志，退出码 3 = 跳过。
 * 显式传参（副本试跑）优先级最高，只处理那一个文件。
 */
const LEGACY_SETTINGS = `${HOME}/.dsh/settings.yaml`;
const MODEL_BLOCK_RE = /^\s*-\s*id:\s*llm-(pi-ai|deepseek)\s*$/m;

/** `profiles/<name>/cordis.patch.yml` 里声明过模型的那些文件。 */
function discoverTargets() {
  const dir = `${HOME}/.dsh/profiles`;
  const found = [];
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const p = join(dir, name, 'cordis.patch.yml');
    try {
      if (MODEL_BLOCK_RE.test(readFileSync(p, 'utf8'))) found.push(p);
    } catch {
      // 没有这个文件 / 读不到：跳过
    }
  }
  if (found.length > 0) return found;
  return existsSync(LEGACY_SETTINGS) ? [LEGACY_SETTINGS] : [];
}

const argTarget = process.argv.slice(2).find((a) => !a.startsWith('-'));
const targets = argTarget ? [argTarget] : discoverTargets();
const CHECK = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');
const QUIET = process.argv.includes('--quiet');

const say = (msg) => { if (!QUIET) console.log(msg); };

/**
 * 极简 YAML 解析器 —— **自带，不依赖任何包**。
 *
 * ⭐ 为什么要自己写：原来这里走 `await import('yaml')`，失败再翻
 *    `~/.dsh/profiles/node_modules`。两处都不成立时**静默跳过探测** ——
 *    而插件的 `dependencies` 里那个 `yaml` 在别的机器上根本装不出来
 *    （profile 的 node_modules 常是空的），等于发布出去就不工作。
 *    解析器照抄 `sync-from-web.mjs`（同机同结构，行为一致）。
 *
 * 支持本文件用到的子集：顶层 map 或 array、嵌套 map、`- ` 列表、
 * 引号标量、true/false/null/数字。**不支持**锚点、多行标量、流式 `{}`/`[]` —— 
 * 而 web 端模型配置里不会出现这些。
 */
function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  // ⚠️ 顶层可能是 map（老版 settings.yaml）也可能是 **array**（cordis.patch.yml）。
  //    先探测：第一行有效行以 `- ` 开头 → 数组。不定这层，patch 文件会被解析成
  //    一个只含最后一个条目字段的 map，`['llm-pi-ai']` 取不到 → provider 全丢。
  const firstLine = lines.find((l) => l.trim() && !l.trim().startsWith('#'));
  const isArrayDoc = /^\s*-\s+/.test(firstLine ?? '');
  const root = isArrayDoc ? [] : {};
  const stack = [{ indent: -1, node: root }];

  const stripComment = (s) => {
    let out = '';
    let q = null;
    for (const ch of s) {
      if (q) {
        out += ch;
        if (ch === q) q = null;
      } else if (ch === '"' || ch === "'") {
        q = ch;
        out += ch;
      } else if (ch === '#') break;
      else out += ch;
    }
    return out.trimEnd();
  };

  const parseScalar = (raw) => {
    const v = raw.trim();
    if (v === '') return '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~') return null;
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d*\.\d+$/.test(v)) return Number(v);
    return v;
  };

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const noComment = stripComment(raw);
    if (!noComment.trim()) continue;
    const indent = noComment.match(/^\s*/)[0].length;
    const body = noComment.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    if (body.startsWith('- ')) {
      const item = body.slice(2).trim();
      // ⚠️ 数组的父容器：上面遇到 `models:`（空值）时建的是 map，
      //    这里必须就地换成 array，否则 push 全丢（解析结果为空）。
      // ⚠️⚠️ 换完必须**重新取 parent** —— parent 是在换之前取的，仍指向被丢弃的旧 map。
      if (stack.length > 1) {
        const top = stack[stack.length - 1];
        if (top.node && !Array.isArray(top.node) && top.parent && top.key !== undefined) {
          const arr = [];
          top.parent[top.key] = arr;
          top.node = arr;
        }
      }
      const listParent = stack[stack.length - 1].node;
      if (!Array.isArray(listParent)) continue;
      const m = item.match(/^(["']?[\w.$-]+["']?):\s*(.*)$/);
      if (m) {
        const obj = {};
        const k = m[1].replace(/^["']|["']$/g, '');
        if (m[2] !== '') obj[k] = parseScalar(m[2]);
        listParent.push(obj);
        stack.push({ indent, node: obj });
      } else {
        listParent.push(parseScalar(item));
      }
      continue;
    }

    const m = body.match(/^(["']?[\w.$-]+["']?):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].replace(/^["']|["']$/g, '');
    const rest = m[2];
    if (rest === '') {
      const container = {};
      parent[key] = container;
      stack.push({ indent, node: container, key, parent });
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return root;
}

/** 1x1 红色 PNG。 */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TIMEOUT_MS = 15000;

function loadKeys() {
  try {
    const doc = parseYaml(readFileSync(`${HOME}/.dsh/.credentials.yaml`, 'utf8'));
    return doc?.refs ?? {};
  } catch {
    return {};
  }
}

/** 探测单个模型是否接受图片。返回 'vision' | 'no' | 'unknown'。 */
async function probe(baseURL, apiKeyEnv, modelId, keys) {
  // 服务商没写 baseURL（本地 llama.cpp 一类）→ 没得探；不挡的话 .replace 会把整轮探测炸掉。
  if (typeof baseURL !== 'string' || baseURL === '') {
    return { verdict: 'unknown', why: '服务商没写 baseURL' };
  }
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
    // ⚠️ 只有报错**明确提到图片**才判「不支持识图」，其余一律 unknown（不动标记）。
    //    老写法把任何 400/404/422 都当不支持：模型名写错、max_tokens 不认、端点形状不同，
    //    都会被插上 `input: [text]`，而标记是粘的 —— 一次误判 = 识图被永久关掉。
    const text = await res.text().catch(() => '');
    const imageRelated = /image|vision|multimodal|图片|多模态/i.test(text);
    if (imageRelated && [400, 404, 422].includes(res.status)) {
      return { verdict: 'no', why: `HTTP ${res.status}` };
    }
    return {
      verdict: 'unknown',
      why: `HTTP ${res.status}${imageRelated ? '' : '（报错没提图片，不判定为不支持）'}`,
    };
  } catch (e) {
    return { verdict: 'unknown', why: e.name === 'TimeoutError' ? '超时' : e.message };
  }
}

/** 在文件文本中定位某模型条目的行区间，返回 {start, end}（含首含尾，0 基）。
 *
 *  ⚠️ 缩进不能写死：模型条目的缩进取决于它嵌在哪：
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

/**
 * 把条目内的 `inputModalities` 设成给定清单；没有这个键就插到 id 行下面。
 * 缩进按条目行 (`- id:`) 的实际缩进 +2 推算，⛔ 不写死——patch 与 settings.yaml 的层深不同。
 * @returns {boolean} 是否真的改了行
 */
function setInputModalities(lines, r, want) {
  const pad = ' '.repeat(r.indent + 2);
  const head = new RegExp(`^${pad}inputModalities:\\s*$`);
  const item = new RegExp(`^${pad}  - `);
  const block = [`${pad}inputModalities:`, ...want.map((x) => `${pad}  - ${x}`)];
  for (let i = r.start + 1; i <= r.end; i += 1) {
    if (!head.test(lines[i])) continue;
    let j = i + 1;
    while (j <= r.end && item.test(lines[j])) j += 1;
    const same = j - i - 1 === want.length && want.every((x, k) => lines[i + 1 + k].trim() === `- ${x}`);
    if (same) return false;
    lines.splice(i, j - i, ...block);
    return true;
  }
  lines.splice(r.start + 1, 0, ...block);
  return true;
}

/**
 * 摘掉条目里的「纯文字」标记（`input:` 行 + 它唯一的 `- text` 项）。从区间尾部往前删，行号不失效。
 * ⛔ 只在清单确实只有 text 时才删：清单里还有 image 时删掉 `input:` 行，会把 image 项留成悬空行，
 *   YAML 把它折进上一行的值（`contextWindow: 65536 - image`）—— 解析不报错，但模型配置对 DSH
 *   是非法值，整段 provider 作废、一个适配器都注册不上（报「no adapter registered」）。
 * @returns {boolean} 是否真的删了行
 */
function removeMark(lines, r) {
  const pad = ' '.repeat(r.indent + 2);
  const head = new RegExp(`^${pad}input:\\s*$`);
  const item = new RegExp(`^${pad}  - (\\S+)\\s*$`);
  for (let i = r.end; i >= r.start; i -= 1) {
    if (!head.test(lines[i])) continue;
    const items = [];
    for (let j = i + 1; j <= r.end; j += 1) {
      const m = lines[j].match(item);
      if (!m) break;
      items.push(m[1]);
    }
    if (items.length !== 1 || items[0] !== 'text') return false;
    lines.splice(i, 2);
    return true;
  }
  return false;
}

/** 往上找第一条非空、非注释行；找不到返回 -1。 */
function prevContentLine(lines, from) {
  for (let i = from; i >= 0; i -= 1) {
    if (lines[i].trim() === '' || /^\s*#/.test(lines[i])) continue;
    return i;
  }
  return -1;
}

/**
 * 补回「键行被删掉」的 `- text` / `- image` 项：它们直接跟在 `key: 数值` 后面。
 *   ⚠️ 这种形状 YAML 照样解析（折进上一行的值），所以「写回前重新解析」那道闸拦不住它 ——
 *      只能按形状认出来单独修，否则坏配置一直留着，整段 provider 全部没有适配器。
 *   只认「比上一条内容行缩进更深」的 text/image 项：模型列表里缩进更浅的兄弟项不受影响。
 * @returns {number} 修好的处数
 */
function repairDanglingInput(lines) {
  let fixed = 0;
  for (let i = lines.length - 1; i >= 1; i -= 1) {
    const m = lines[i].match(/^(\s*)-\s+(text|image)\s*$/);
    if (!m) continue;
    const prev = lines[prevContentLine(lines, i - 1)] ?? '';
    const key = prev.match(/^(\s*)[A-Za-z][\w-]*:\s*(\S.*)$/);
    if (!key || m[1].length <= key[1].length) continue;
    const pad = ' '.repeat(m[1].length - 2);
    let end = i;
    const item = new RegExp(`^${pad}  - (text|image)\\s*$`);
    while (end + 1 < lines.length && item.test(lines[end + 1])) end += 1;
    const items = lines.slice(i, end + 1).map((l) => l.trim().replace(/^-\s+/, ''));
    if (!items.includes('text')) items.unshift('text'); // 被删掉的正是 `- text` 那一行
    lines.splice(i, end - i + 1, `${pad}input:`, ...items.map((x) => `${pad}  - ${x}`));
    fixed += 1;
  }
  return fixed;
}

/**
 * 写回前的结构闸：`- xxx` 项比上一条内容行缩进更深、而上一条是「键: 值」，YAML 就会把它折进那个值。
 * 解析不报错，但那行值变字符串 —— DSH 校验不过、整段 provider 作废，所以这种形状一律不许写回。
 * @returns {number[]} 可疑行的行号（1 基）；空数组 = 通过
 */
function findDanglingItems(lines) {
  const bad = [];
  for (let i = 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*)-\s+\S/);
    if (!m) continue;
    const prev = lines[prevContentLine(lines, i - 1)] ?? '';
    const key = prev.match(/^(\s*)[A-Za-z][\w-]*:\s*(\S.*)$/);
    if (key && m[1].length > key[1].length) bad.push(i + 1);
  }
  return bad;
}

/**
 * 探测结果缓存（进程级，跨 profile 共用）：key = `baseURL\0模型 id`。
 * 同一台机器的多个 profile 常是同一份模型配置的副本 —— 不共用缓存就会把
 * 同一个模型问 N 遍（每个 profile 一遍）。
 */
const verdicts = new Map();

async function processTarget(target) {
  let src;
  try {
    src = readFileSync(target, 'utf8');
  } catch {
    say(`⏭ 未找到 ${target} —— 跳过。`);
    return;
  }
  const lines = src.split('\n');

  // ── 第 0 步：补回历史坏行（见 repairDanglingInput）──
  //   ⚠️ 必须在取 providers **之前**：坏行会改变上一行键的解析结果，
  //      先修再解析，providers 才是真实形状。
  const repaired = repairDanglingInput(lines);
  if (repaired > 0) say(`🔧 补回 ${repaired} 处被删坏的 input: 键行`);

  const doc = parseYaml(lines.join('\n'));
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

  // ── 第 1 步：确保每个服务商都有 defaultInput（「假设都有识图」层）──
  //   ⚠️ 缩进按 baseURL 行的实际缩进推算（defaultInput 与 baseURL 同级，其列表项再深 2），
  //      不写死 6 空格 —— patch 文件里是 8，写死就注错层、YAML 直接坏掉。
  let changed = repaired > 0;
  //   锚点必须限定在**该服务商自己的块**里找：两家服务商共用同一个 baseURL 时，全文件取第一处
  //   会把 defaultInput 注进**上一家**的块 —— 那家每跑一次多一条重复键，要补的这家永远补不上。
  //   块里已有 defaultInput（哪怕已是重复键的坏形状）一律一字不动。
  const escPat = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const providerBlock = (name) => {
    const start = lines.findIndex((l) => new RegExp(`^(\\s*)${escPat(name)}:\\s*$`).test(l));
    if (start === -1) return null;
    const pad = lines[start].match(/^(\s*)/)[1];
    const sibling = new RegExp(`^${pad}[^\\s#][^:]*:`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (sibling.test(lines[i])) { end = i; break; }
    }
    return { start, end, pad, text: lines.slice(start, end).join('\n') };
  };
  for (const [name, p] of Object.entries(providers)) {
    const blk = providerBlock(name);
    if (!blk) { say(`⚠️ ${name}: 找不到服务商块，跳过 defaultInput`); continue; }
    if (/^\s*defaultInput\s*:/m.test(blk.text) || p?.defaultInput?.includes('image')) continue;
    const esc = escPat(p.baseURL ?? '');
    if (!esc) { say(`⚠️ ${name}: 无 baseURL，跳过 defaultInput`); continue; }
    const at = lines
      .slice(blk.start, blk.end)
      .findIndex((l) => new RegExp(`^\\s*baseURL: ["']?${esc}["']?\\s*$`).test(l));
    if (at === -1) { say(`⚠️ ${name}: 找不到 baseURL 锚点，跳过 defaultInput`); continue; }
    if (CHECK) { say(`（将给 ${name} 补 defaultInput）`); continue; }
    //   缩进按 **baseURL 行**的实际缩进推算（defaultInput 与 baseURL 同级），
    //   ⛔ 不能用服务商名那行的缩进 —— 名在 providers 下、键还要再深一级，写错就注成别人的兄弟键。
    const basePad = lines[blk.start + at].match(/^(\s*)/)[1];
    const INJECT = [`${basePad}defaultInput:`, `${basePad}  - text`, `${basePad}  - image`];
    lines.splice(blk.start + at + 1, 0, ...INJECT);
    changed = true;
    say(`✅ ${name}: 已补 defaultInput [text, image]`);
  }
  // 重新按（可能已变的）行集工作
  const work = lines;

  // ── 第 2 步：逐模型探测（并发）──
  //   同一台机器上多个 profile 常是同一份模型配置的副本，同一个
  //   `服务商+模型` 只探一次（结果按 key 复用），否则一份配置 × N 个 profile
  //   会在每次启动时把同一个问题问 N 遍。
  const jobs = [];
  for (const [name, p] of Object.entries(providers)) {
    for (const m of p?.models ?? []) {
      const r = findEntry(work, m.id);
      if (!r) { jobs.push({ name, id: m.id, run: null, note: '找不到条目' }); continue; }
      // 本地/免配服务商（没 baseURL）不探测：探测函数会抛异常，整轮探测直接崩。
      if (typeof p?.baseURL !== 'string' || p.baseURL === '') {
        jobs.push({ name, id: m.id, run: null, note: '服务商没写 baseURL，不探测' });
        continue;
      }
      const marked = entryHasInput(work, r);
      // 服务商声明了识图，而模型条目上还盖着「纯文字」旧标记 —— 这对矛盾必须复测：
      // 标记是粘的，不复测就是一次误判永久关掉识图（本机的实际翻车方式）。
      const providerSaysVision = Array.isArray(p?.defaultInput) && p.defaultInput.includes('image');
      if (marked && !FORCE && !providerSaysVision) {
        jobs.push({ name, id: m.id, run: null, note: '已有标记，跳过（--force 重测）' });
        continue;
      }
      const probeKey = `${p.baseURL}\u0000${m.id}`;
      if (!verdicts.has(probeKey)) verdicts.set(probeKey, probe(p.baseURL, p.apiKeyEnv, m.id, keys));
      jobs.push({ name, id: m.id, entry: r, retest: marked, run: verdicts.get(probeKey) });
    }
  }
  //  内置 DeepSeek 档（`llm-deepseek`）也真探：
  //    · 这档的 models 直接挂在 config 下，接口常是 `/anthropic` 形状 —— OpenAI 兼容
  //      口子在 `/v1`，所以探之前把结尾的 `/anthropic` 换成 `/v1`（别的地址原样用）。
  //    · 模型条目缺 `inputModalities`（或只写 text）时，DSH 就当它「只收文字」，
  //      图在最后一站被换成占位符 —— 探到能看图就把 image 补进清单。
  //    · 探不到 / 不确认 ⇒ 一个字都不改（⛔ 不猜）。
  const dsEntry = Array.isArray(doc) ? doc.find((e) => e?.id === 'llm-deepseek') : doc?.['llm-deepseek'];
  const dsCfg = dsEntry?.config ?? dsEntry ?? {};
  const dsBase = typeof dsCfg?.baseURL === 'string' && dsCfg.baseURL
    ? dsCfg.baseURL.replace(/\/anthropic\/?$/, '/v1')
    : 'https://api.deepseek.com/v1';
  const dsKeyEnv = dsCfg?.apiKeyEnv || 'DEEPSEEK_API_KEY';
  const dsJobs = [];
  for (const m of Array.isArray(dsCfg?.models) ? dsCfg.models : []) {
    const id = m?.id ?? m;
    if (!id) continue;
    const probeKey = `${dsBase}\u0000${id}`;
    if (!verdicts.has(probeKey)) verdicts.set(probeKey, probe(dsBase, dsKeyEnv, id, keys));
    dsJobs.push({ id, run: verdicts.get(probeKey) });
  }

  await Promise.all([...jobs, ...dsJobs].map(async (j) => {
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
      if (hasMark && (FORCE || j.retest)) {
        // 复测翻案：原来标了纯文字、现在通了 —— 不摘旧标记就永远用不上识图。
        ops.push({ pos: j.entry.end, entry: j.entry, kind: 'remove', name: j.name, id: j.id });
        say(`🔄 ${j.name}/${j.id}: 复测识图正常 → 摘除旧纯文字标记`);
      } else say(`✅ ${j.name}/${j.id}: 识图正常`);
    } else if (v === 'no') {
      if (hasMark) {
        // ⛔ --force 复测「仍不支持」时条目里已有 input:，必须查重：
        //    再插一次 = 重复键 = 整份模型配置变非法 YAML。
        say(`⏭ ${j.name}/${j.id}: 仍不支持，维持原标记（不重复插入）`);
        continue;
      }
      // input 与条目内其它键（id/name）同级：比 `- ` 再深 2，按条目实际缩进推算。
      const p2 = ' '.repeat((j.entry.indent ?? 8) + 2);
      ops.push({ pos: j.entry.end + 1, kind: 'insert', pad: p2 });
      say(`⛔ ${j.name}/${j.id}: 不支持识图（${j.result.why}）→ 将标记纯文字`);
    } else say(`⚠️ ${j.name}/${j.id}: 未知（${j.result.why}）→ 不动`);
  }
  ops.sort((a, b) => b.pos - a.pos); // 从后往前，行号不失效
  for (const op of ops) {
    if (CHECK) continue;
    if (op.kind === 'insert') {
      work.splice(op.pos, 0, `${op.pad}input:`, `${op.pad}  - text`);
      changed = true;
    } else if (removeMark(work, op.entry)) {
      changed = true;
    } else {
      // 标记清单里还有 image：删 `input:` 会留下悬空的 image 项、整段配置作废。
      say(`⏭ ${op.name}/${op.id}: 标记清单里不止 text —— 不摘（摘了会留悬空项）`);
    }
  }

  // ── 官方 DeepSeek 档：能看图就把 image 补进 inputModalities ──
  //   为什么必须补：DSH 把「模型条目没有 image」当成只收文字，图会被换成占位符；
  //   而这份清单常常只写了 id/name，能力就丢失了。
  for (const j of dsJobs) {
    const v = j.result?.verdict;
    if (v !== 'vision') {
      if (j.run) {
        say(
          `ℹ️ 官方 DeepSeek 档/${j.id}: ${v === 'no' ? `不支持识图（${j.result.why}）` : `未确认（${j.result.why}）`} —— 配置不动`,
        );
      }
      continue;
    }
    const r = findEntry(work, j.id);
    if (!r) { say(`⚠️ 官方 DeepSeek 档/${j.id}: 找不到条目，跳过`); continue; }
    if (CHECK) { say(`（将给官方 DeepSeek 档/${j.id} 补 inputModalities [text, image]）`); continue; }
    if (setInputModalities(work, r, ['text', 'image'])) {
      changed = true;
      say(`✅ 官方 DeepSeek 档/${j.id}: 已补 inputModalities [text, image]`);
    }
  }

  if (CHECK) { say('（--check 未写文件）'); return; }
  if (!changed) { say('无改动。'); return; }
  // ⛔ 最后一道闸：写回前必须能整体重新解析成合法 YAML，解析不过一字不写。
  //   （web 端模型配置坏一份 = providers/permission 全丢。）
  try {
    parseYaml(work.join('\n'));
  } catch (err) {
    console.error(`⛔ 生成的 YAML 解析失败（${err.message}）—— 已放弃写回，原文件未动。`);
    process.exit(1);
  }
  // ⛔ 第二道闸：解析通过 ≠ 能用 —— 悬空列表项（见 findDanglingItems）解析得出来，
  //   但 DSH 校验不过、整段 provider 作废，一样是一字不写。
  const dangling = findDanglingItems(work);
  if (dangling.length > 0) {
    console.error(`⛔ 生成的 YAML 有悬空列表项（第 ${dangling.join('、')} 行）—— 已放弃写回，原文件未动。`);
    process.exit(1);
  }
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const backup = `${target}.bak.visionauto-${ts}`;
  copyFileSync(target, backup);
  writeFileSync(target, work.join('\n'));
  say(`\n✅ 已写回 ${target}（备份：${backup}）。重启 bot 后生效。`);
}

async function main() {
  if (targets.length === 0) {
    console.error('⏭ 跳过识图探测：没有找到声明模型的配置（profiles/*/cordis.patch.yml、settings.yaml 都没有）。');
    // 退出码 3 = 「没干活」。调用方据此记「跳过」，不再把跳过写成「探测完成」。
    process.exit(3);
  }
  for (const target of targets) {
    say(`──── ${target} ────`);
    await processTarget(target);
  }
}
main().catch((e) => { console.error('⛔ vision-auto 失败:', e.message); process.exit(1); });

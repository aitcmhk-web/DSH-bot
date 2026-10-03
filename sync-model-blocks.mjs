#!/usr/bin/env node
/**
 * 模型清单同步：**单一权威源 + 广播到各 profile**（⛔ 不是两两镜像，见 AGENTS.md 第 1 条）
 *
 * ## 为什么要「权威源」而不是 A↔B 互相搬
 * A↔B 成对搬运在节点变多时会退化成 N²，而且「谁赢」要判两次 → bug 的种子。
 * 这里只保留**一个权威源**：`models-authority.json`（本目录，机器本地状态、gitignored）。
 * 两个 profile 的 `cordis.patch.yml` 都是它的**衍生副本**；任何一端改了 → 更新权威源 →
 * 广播给**所有** profile。以后加第三个端 = 在 `targets` 里多一行，不用改判定逻辑。
 *
 * ## 为什么需要它
 * 网页版 `~/.dsh/profiles/web/` 和桌面版 `~/.dsh/profiles/desktop/` 是同一个
 * `@deepseek-ai/dsh-web-app`，只是 profile 目录不同；菜单里能看到哪些模型由各自 profile 的
 * `cordis.patch.yml` 里的 `llm-pi-ai`（provider/model 表）和 `llm-deepseek`（内置档 baseURL）决定。
 * 桌面端原本一个模型块都没有 → 第一次必须是**整块复制**，不是增量。
 *
 * ## 同步什么 / 不同步什么
 * - ✅ 托管块（= 权威源里有的块）：`llm-pi-ai`、`llm-deepseek`（模型清单本身）。
 * - ⛔ 不托管（各端自己的，广播时**原样保留、逐字不动**）：界面偏好（`ui-chat` 的
 *   compact/verbose、`ui-settings` 的 enabled）、`agent-default-model`（「当前选中哪一档」是
 *   各端自己的选择，不是清单）、桌面端手写的 `- insert: hard-rules` 段。
 *
 * ## 规则（可预测优先）
 * - 某端该块的内容 ≠ 权威源 **且** 该文件 mtime 比权威源新 → 视为「这次编辑」，成为新权威源。
 * - 多点同时改 → **mtime 最新的赢**，其余端被覆盖，并在日志里点名（conflict）。
 * - 某端缺该块 → **补上**（第一次全量复制靠这条）。
 * - 两端都缺该块且比权威源新 → 视作「两边都删了」→ 权威源删掉这条（⛔ 不无限往回复活）。
 * - 内容比较一律用**去尾空白的整块字节比较** → 写完两边一致，⛔ 不会来回抖动。
 * - 日志里打「谁改了哪块」，不猜语义、不合并 provider。
 *
 * ## 安全（见 AGENTS.md 第 7 条）
 * - 写入前断言「**非托管部分逐字未变**」（注释 / 其它块 / 手写段），否则拒绝写并报错。
 * - 每个文件**本进程第一次写**之前先备份 `*.bak.modelsync-<时间戳>`。
 * - 写入走**同目录临时文件 + rename 原子替换**（dsh 的 HMR 只看得到完整文件）。
 *
 * ## 用法
 *   node sync-model-blocks.mjs --dry-run    # 看要改什么（不写盘）
 *   node sync-model-blocks.mjs --once       # 同步一次
 *   node sync-model-blocks.mjs --watch      # 常驻，每 1.5s 一轮
 * 环境变量：MODELSYNC_WEB / MODELSYNC_DESKTOP / MODELSYNC_AUTHORITY / MODELSYNC_INTERVAL_MS /
 *          MODELSYNC_NO_BACKUP=1（测试用）/ MODELSYNC_DISABLE=1（停用，测试 spawn 真 bot 时必须设）
 */

import { readFileSync, writeFileSync, renameSync, copyFileSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 托管块白名单：只有这些块会被搬运。 */
export const MANAGED_BLOCKS = ['llm-pi-ai', 'llm-deepseek'];
const ENTRY_RE = /^- /;

export function resolveTargets(env = process.env) {
  const home = env.HOME || homedir();
  const web = env.MODELSYNC_WEB || join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml');
  const desktop = env.MODELSYNC_DESKTOP || join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  const extra = (env.MODELSYNC_EXTRA || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p, i) => ({ label: `extra${i + 1}`, path: p }));
  return [
    { label: 'web', path: web },
    { label: 'desktop', path: desktop },
    ...extra,
  ];
}

export function resolveAuthorityPath(env = process.env) {
  return env.MODELSYNC_AUTHORITY || join(HERE, 'models-authority.json');
}

// ────────────────────────── 文本层：块切割 / 替换 ──────────────────────────

/** 顶层数组切成「前导注释」+ 若干条目；条目从 `- ` 行开始，到下一条 `- ` 行之前。 */
export function splitEntries(text) {
  const lines = String(text).split('\n');
  let first = lines.findIndex((l) => ENTRY_RE.test(l));
  if (first < 0) first = lines.length;
  const preamble = lines.slice(0, first);
  const segs = [];
  for (let i = first; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && !ENTRY_RE.test(lines[j])) j += 1;
    segs.push({ start: i, end: j, lines: lines.slice(i, j) });
    i = j;
  }
  return { preamble, segs, lines };
}

/** 条目的 id；`- insert:` 这类没有 id 的条目返回 null。 */
export function entryId(lines) {
  const m = /^- id:\s*([^\s#]+)/.exec(lines[0] ?? '');
  return m ? m[1] : null;
}

export function blockOf(text, id) {
  const seg = splitEntries(text).segs.find((s) => entryId(s.lines) === id);
  return seg ? { lines: seg.lines, text: seg.lines.join('\n') } : null;
}

/** 比较用归一化：去掉行尾空白与末尾空行（写盘后不会被这点差异反复触发）。 */
export function norm(t) {
  return String(t)
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/** 非托管部分（前导注释 + 所有非托管条目）的签名，用来断言「没少东西」。 */
export function nonManagedSignature(text) {
  const { preamble, segs } = splitEntries(text);
  const keep = segs.filter((s) => !MANAGED_BLOCKS.includes(entryId(s.lines)));
  // `[]` 是「空数组」占位符，补块时会被删掉 → 不算非托管内容
  const head = preamble.filter((l) => l.trim() !== '[]');
  return [head.join('\n'), ...keep.map((s) => s.lines.join('\n'))].join('\n<<<>>>\n');
}

/**
 * 一次性把多个块写进同一份文本：已有的**原地整块替换**，缺的**插到数组最前面**
 * （前导注释之后），插入顺序按传参顺序 → 结果稳定可预测。
 */
export function applyBlocks(targetText, blocks) {
  let out = String(targetText).split('\n');
  const missing = [];
  for (const b of blocks) {
    const { segs } = splitEntries(out.join('\n'));
    const idx = segs.findIndex((s) => entryId(s.lines) === b.id);
    if (idx >= 0) {
      const s = segs[idx];
      out.splice(s.start, s.end - s.start, ...b.lines, ''); // 段尾统一留一个空行
    } else {
      missing.push(b);
    }
  }
  if (missing.length) {
    out = out.filter((l) => l.trim() !== '[]'); // 清掉空数组占位
    const at = out.findIndex((l) => ENTRY_RE.test(l));
    const chunk = [];
    for (const b of missing) chunk.push(...b.lines, '');
    out.splice(at < 0 ? out.length : at, 0, ...chunk);
  }
  return out.join('\n');
}

// ────────────────────────── 权威源读写 ──────────────────────────

export function loadAuthority(path) {
  if (!existsSync(path)) return { version: 1, blocks: {} };
  const raw = readFileSync(path, 'utf8');
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`权威源 ${path} 不是合法 JSON（${err.message}）：本轮跳过，⛔ 绝不用坏文件去覆盖 profile`);
  }
  if (!obj || typeof obj !== 'object' || typeof obj.blocks !== 'object' || obj.blocks === null) {
    throw new Error(`权威源 ${path} 结构不对（缺 blocks）：本轮跳过`);
  }
  return { version: 1, blocks: obj.blocks };
}

export function saveAuthority(path, authority) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, ...authority, savedAt: new Date().toISOString() }, null, 2) + '\n');
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// ────────────────────────── 决策 ──────────────────────────

function readSide({ label, path }) {
  if (!existsSync(path)) return { label, path, text: null, mtimeMs: 0, missing: true };
  const st = statSync(path);
  return { label, path, text: readFileSync(path, 'utf8'), mtimeMs: st.mtimeMs, size: st.size };
}

/**
 * 算出一轮要做的事。纯函数（不写盘），便于 dry-run 与测试。
 * @returns {{next:{blocks:Object}, writes:Array<{path:string,label:string,blocks:Array<{id:string,lines:string[]}>}>, decisions:Array<Object>, sides:Array<Object>}}
 */
export function computePlan({ targets, authority }) {
  const sides = targets.map(readSide);
  const next = { blocks: { ...authority.blocks } };
  const decisions = [];
  const wanted = new Map(); // id -> text

  for (const id of MANAGED_BLOCKS) {
    const present = sides
      .filter((s) => s.text !== null && blockOf(s.text, id))
      .map((s) => ({ side: s, text: norm(blockOf(s.text, id).text) }));
    const auth = authority.blocks[id];

    if (!auth) {
      if (!present.length) continue;
      const cands = [...present].sort((a, b) => b.side.mtimeMs - a.side.mtimeMs);
      next.blocks[id] = { text: cands[0].text, updatedAt: cands[0].side.mtimeMs };
      wanted.set(id, cands[0].text);
      decisions.push({ id, action: 'seed', from: cands[0].side.label });
      continue;
    }

    const cands = present.filter((p) => p.text !== auth.text && p.side.mtimeMs > auth.updatedAt + 1);
    if (cands.length) {
      cands.sort((a, b) => b.side.mtimeMs - a.side.mtimeMs);
      const win = cands[0];
      next.blocks[id] = { text: win.text, updatedAt: win.side.mtimeMs };
      wanted.set(id, win.text);
      decisions.push({
        id,
        action: 'update',
        from: win.side.label,
        conflict: cands.slice(1).map((c) => c.side.label),
      });
      continue;
    }

    // 两边都没有这块、而且都比权威源新 → 认定「两边都删了」
    const newest = Math.max(...sides.map((s) => s.mtimeMs));
    if (!present.length && newest > auth.updatedAt + 1) {
      delete next.blocks[id];
      decisions.push({ id, action: 'drop', from: 'both' });
      continue;
    }

    wanted.set(id, auth.text);
  }

  // 广播：任何端该块内容 ≠ 权威内容 → 排队重写（含「缺失补上」）
  const writesByPath = new Map();
  for (const [id, text] of wanted) {
    for (const s of sides) {
      if (s.text === null) continue;
      const cur = blockOf(s.text, id);
      if (cur && norm(cur.text) === text) continue;
      if (!writesByPath.has(s.path)) writesByPath.set(s.path, { path: s.path, label: s.label, blocks: [] });
      writesByPath.get(s.path).blocks.push({ id, lines: text.split('\n') });
    }
  }
  return { next, writes: [...writesByPath.values()], decisions, sides };
}

// ────────────────────────── 写盘 ──────────────────────────

const backedUp = new Set();

/** 原子替换：同目录临时文件 + rename（HMR 只看得到完整文件）。 */
export function atomicWrite(path, text) {
  const st = statSync(path);
  const tmp = join(dirname(path), `.${basename(path)}.modelsync-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: st.mode & 0o7777 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function backupOnce(path, log, env = process.env) {
  if (env.MODELSYNC_NO_BACKUP === '1') return null;
  if (backedUp.has(path)) return null;
  const stamp = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
    .replace(/[-: ]/g, '')
    .slice(0, 14);
  const bak = `${path}.bak.modelsync-${stamp}`;
  copyFileSync(path, bak);
  backedUp.add(path);
  log(`[modelsync] 🗄 备份 ${bak}`);
  return bak;
}

// ────────────────────────── 一轮同步 ──────────────────────────

/**
 * @param {{dryRun?:boolean, targets?:Array, authorityPath?:string, log?:(s:string)=>void, env?:object}} opts
 */
export function syncOnce({
  dryRun = false,
  targets = resolveTargets(),
  authorityPath = resolveAuthorityPath(),
  log = console.log,
  env = process.env,
} = {}) {
  const authority = loadAuthority(authorityPath);
  const { next, writes, decisions, sides } = computePlan({ targets, authority });
  for (const d of decisions) {
    const extra = d.conflict?.length ? `，⚠️ 同时改的还有 ${d.conflict.join('/')}（被覆盖）` : '';
    log(`[modelsync] ${d.action === 'drop' ? '两端都删了' : `${d.from} 改了`} ${d.id}${extra}`);
  }
  for (const s of sides) {
    if (s.missing) log(`[modelsync] ⚠️ ${s.label} 的 patch 文件不存在，跳过：${s.path}`);
  }
  if (!decisions.length && !writes.length) return { decisions, writes: [], written: [] };

  // 先落权威源（若中途崩，文件与权威不一致 → 下一轮自我修复）
  if (!dryRun) saveAuthority(authorityPath, next);

  const written = [];
  for (const w of writes) {
    const side = sides.find((s) => s.path === w.path);
    const before = side.text;
    const after = applyBlocks(before, w.blocks);
    if (after === before) continue;
    if (nonManagedSignature(before) !== nonManagedSignature(after)) {
      throw new Error(`[modelsync] ⛔ 拒绝写入 ${w.path}：非托管部分会发生变化（这是 bug，不是配置问题）`);
    }
    const list = w.blocks.map((b) => b.id).join(', ');
    if (dryRun) {
      log(`[modelsync] (dry-run) ${side.label} ← 权威源：${list}`);
      for (const b of w.blocks) {
        const cur = blockOf(before, b.id);
        log(unifiedDiff(cur ? cur.text : '', b.lines.join('\n'), `${b.id} @ ${w.path}`));
      }
      continue;
    }
    const fresh = statSync(w.path);
    if (fresh.mtimeMs !== side.mtimeMs || fresh.size !== side.size) {
      log(`[modelsync] ${side.label} 在我读取后被改过，本轮跳过，下轮再来`);
      continue;
    }
    backupOnce(w.path, log, env);
    atomicWrite(w.path, after);
    const now = statSync(w.path);
    written.push({ path: w.path, ids: w.blocks.map((b) => b.id) });
    log(`[modelsync] ✅ 已写入 ${side.label} ← 权威源：${list}（${now.size} B）`);
  }
  return { decisions, writes, written };
}

/** 简易 unified diff（块都很小，LCS 就够）。 */
export function unifiedDiff(oldText, newText, label = '') {
  const a = String(oldText).split('\n');
  const b = String(newText).split('\n');
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(' ' + a[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push('-' + a[i]);
      i += 1;
    } else {
      out.push('+' + b[j]);
      j += 1;
    }
  }
  while (i < n) out.push('-' + a[i++]);
  while (j < m) out.push('+' + b[j++]);
  return `--- ${label}\n@@ 非托管部分未变，仅此块 @@\n${out.join('\n')}\n`;
}

export function startWatch({
  intervalMs = Number(process.env.MODELSYNC_INTERVAL_MS ?? 1500),
  targets = resolveTargets(),
  authorityPath = resolveAuthorityPath(),
  log = console.log,
} = {}) {
  // 测试会 spawn 真 bot.js（test-cursor / test-e2e），必须能显式停用，否则测试会去写真配置
  if (process.env.MODELSYNC_DISABLE === '1') {
    log('[modelsync] 已按 MODELSYNC_DISABLE=1 停用（不写任何 profile）');
    return null;
  }
  let warned = false;
  const tick = () => {
    try {
      syncOnce({ targets, authorityPath, log });
    } catch (err) {
      // 同步坏掉绝不影响 bot 本体：只打日志，⛔ 不抛
      if (!warned) {
        log(`[modelsync] ⛔ ${err.message}`);
        warned = true;
      }
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = new Set(process.argv.slice(2));
  const targets = resolveTargets();
  const authorityPath = resolveAuthorityPath();
  if (args.has('--dry-run')) {
    console.log(`[modelsync] 权威源 = ${authorityPath}`);
    for (const t of targets) console.log(`[modelsync]   ${t.label} = ${t.path}`);
    const { decisions, writes } = syncOnce({ dryRun: true, targets, authorityPath });
    console.log(
      decisions.length || writes.length
        ? `[modelsync] 计划：${decisions.map((d) => `${d.action}:${d.id}`).join(' ') || '(仅补齐)'}，要写 ${writes.length} 个文件`
        : '[modelsync] 已一致，无需改动',
    );
  } else if (args.has('--watch')) {
    console.log(`[modelsync] 常驻同步（每 ${Number(process.env.MODELSYNC_INTERVAL_MS ?? 1500)}ms），权威源 ${authorityPath}`);
    startWatch({ targets, authorityPath });
  } else if (args.has('--once') || args.size === 0) {
    const { written } = syncOnce({ targets, authorityPath });
    console.log(written.length ? `[modelsync] 写了 ${written.length} 个文件` : '[modelsync] 已一致，无需改动');
  } else {
    console.log('用法：node sync-model-blocks.mjs [--dry-run | --once | --watch]');
    process.exitCode = 2;
  }
}

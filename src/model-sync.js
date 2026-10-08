/**
 * 插件版自愈：把**本 profile** 的模型块（`llm-pi-ai` / `llm-deepseek`）与 **web 端**补齐。
 *
 * 为什么必须有这一环（2026-10-09 定案，用户报障「增加大模型后插件版报
 * ❌ no adapter registered for provider "xiaomi-token-plan-cn"，软件版正常」）：
 *   - 插件菜单读的是 web 那份 patch（见 `./web-patch.js`），所以 web 里加完模型**菜单立刻有**；
 *   - 但 `dsh-llm-pi-ai` 注册 adapter **只认本 profile 组合出来的 `config.providers`**
 *     （`lib/index.js` 的 `apply()` 与 `ctx.on("loader/volatile-update")` 各算一次
 *      `registrationFacts(profiles())`），**没有**给第三方插件注入 provider 的 API；
 *   - 而 `sync-model-blocks.mjs` 的广播目标是 web + desktop，**不管插件 profile**；
 *   - 于是「web 有、本 profile 没有」的 provider 一被选中就抛 `no adapter registered`。
 *   ⇒ 插件启动时自己在**本 profile** 里把 web 的块补齐，HMR 热重载让 pi-ai 重新注册。
 *
 * 口径（**只增不改不删**，与 `setupbot.sh` 的 `ensure_provider_block()` 同源，
 * 比软件版的「整块替换」更保守）：
 *   - 本地已有的行**一个字不动**，只把 web 有、本地缺的节点追加进来；
 *   - 缺 provider → 整个 provider 子树照抄；缺 model → 整段 model 照抄；
 *     缺标量键（如 `contextWindow`）→ 只补那一行；
 *   - 缩进按「父子节点缩进差量」平移，**不猜语义、不合并同名 provider 的内容**。
 *   ⛔ 本地多出来的 provider / 模型永远保留 —— 别人的 profile 可能有自己的东西。
 *
 * 单写者纪律（见 AGENTS.md 第 1 条 / 第 20 条）：
 *   - 本模块**只写插件自己所在的 profile**，**从不写 web**（web 是源，见 web-patch.js 头注释）；
 *   - web / desktop 的广播仍是软件版 bot 的 `sync-model-blocks.mjs` 的活，两者不重叠；
 *   - 尊重 `MODELSYNC_DISABLE=1`（测试 spawn 真 DSH 时必须能停用）。
 *
 * ⛔ 路径用「插件自己的安装位置」反推（`import.meta.url`），不遍历猜测。
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MANAGED_BLOCKS,
  blockOf,
  norm,
  nonManagedSignature,
  applyBlocks,
  atomicWrite,
} from '../sync-model-blocks.mjs';
import { webPatchPath } from './web-patch.js';

const SELF_FILE = fileURLToPath(import.meta.url);
const PKG_ROOT = dirname(dirname(SELF_FILE));

function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * 反推「插件自己所在的 profile 目录」。
 *   ① 安装态：本文件在 `<profile>/node_modules/dsh-botplugin/src/` → 向上找到 `node_modules`，
 *      其父目录就是 profile。
 *   ② 软链 / 开发态：在 `${DSH_HOME:-$HOME/.dsh}/profiles/<P>/node_modules/dsh-botplugin` 里找
 *      realpath 与本包相同的那个 profile（Node 默认 realpath 软链，①会落空）。
 * 反推不出 → 返回 null（例如直接在仓库里跑），交给调用方跳过。
 */
export function detectOwnProfileDir({ selfFile = SELF_FILE, env = process.env } = {}) {
  let d = dirname(selfFile);
  for (let i = 0; i < 12 && d !== dirname(d); i += 1) {
    if (basename(d) === 'node_modules') return dirname(d);
    d = dirname(d);
  }
  const real = realpathSafe(PKG_ROOT);
  if (!real) return null;
  const roots = [env.DSH_HOME, join(env.HOME || homedir(), '.dsh')].filter(Boolean);
  for (const root of roots) {
    const profilesDir = join(root, 'profiles');
    if (!existsSync(profilesDir)) continue;
    let names = [];
    try {
      names = readdirSync(profilesDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const cand = join(profilesDir, name, 'node_modules', 'dsh-botplugin');
      if (existsSync(cand) && realpathSafe(cand) === real) return join(profilesDir, name);
    }
  }
  return null;
}

// ───────────────────── 文本层：只增不改不删的并集补齐 ─────────────────────

const BLANK_RE = /^[ \t]*$/;
const COMMENT_RE = /^[ \t]*#/;
const SEQ_RE = /^[ \t]*-[ \t]/;

function indentOf(line) {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

/** 节点的匹配键：映射取 `key:`，序列项优先取 `- id: X`，其余按整行文本。 */
function keyOf(line) {
  const text = line.trim();
  if (SEQ_RE.test(line)) {
    const m = text.match(/^-[ \t]+id:[ \t]*(\S+)/);
    return m ? `seq:id=${m[1]}` : `seq:${text}`;
  }
  const m = text.match(/^([^\s:#][^:]*?):([ \t]|$)/);
  return m ? `map:${m[1].trim()}` : `raw:${text}`;
}

/** 把行数组按缩进搭成树；空白行 / 注释行不参与匹配（end 落在最后一个非空后代行）。 */
function buildTree(lines) {
  const root = { indent: -1, start: -1, end: lines.length, key: null, children: [] };
  const stack = [root];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (BLANK_RE.test(raw) || COMMENT_RE.test(raw)) continue;
    const indent = indentOf(raw);
    const node = { indent, start: i, end: i + 1, key: keyOf(raw), children: [] };
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    parent.children.push(node);
    for (const s of stack) s.end = i + 1;
    stack.push(node);
  }
  return root;
}

/** 缩进整体平移 delta（只动空格，不改内容）。 */
function rebase(lines, delta) {
  if (!delta) return lines.slice();
  return lines.map((line) => {
    if (!line.trim()) return line;
    return ' '.repeat(Math.max(0, indentOf(line) + delta)) + line.trimStart();
  });
}

function trimTrailingBlank(lines) {
  const out = lines.slice();
  while (out.length && BLANK_RE.test(out[out.length - 1])) out.pop();
  return out;
}

/**
 * 把 `srcLines`（web 的块）里**本地缺的节点**追加进 `dstLines`（本地块）。
 * 已有的节点只递归往下比对，绝不改动 / 删除任何一行。
 */
export function mergeAdditive(dstLines, srcLines) {
  const inserts = [];
  const walk = (d, s) => {
    for (const sc of s.children) {
      const dc = d.children.find((c) => c.key === sc.key);
      if (dc) {
        walk(dc, sc);
        continue;
      }
      const delta = d.indent - s.indent;
      const at = d.children.length
        ? d.children[d.children.length - 1].end
        : (d.start >= 0 ? d.start + 1 : dstLines.length);
      inserts.push({ at, i: inserts.length, lines: rebase(srcLines.slice(sc.start, sc.end), delta) });
    }
  };
  walk(buildTree(dstLines), buildTree(srcLines));
  if (!inserts.length) return dstLines.slice();
  // 从后往前插；同一位置按源顺序（后进的先插，先插的留在前面）
  inserts.sort((a, b) => b.at - a.at || b.i - a.i);
  const out = dstLines.slice();
  for (const ins of inserts) out.splice(ins.at, 0, ...ins.lines);
  return out;
}

// ────────────────────────── 一轮同步 ──────────────────────────

let backedUp = new Set();

function backupOnce(path, log, env) {
  if (env.MODELSYNC_NO_BACKUP === '1') return null;
  if (backedUp.has(path)) return null;
  const stamp = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
    .replace(/[-: ]/g, '')
    .slice(0, 14);
  const bak = `${path}.bak.pluginsync-${stamp}`;
  try {
    copyFileSync(path, bak);
  } catch {
    return null;
  }
  backedUp.add(path);
  log(`[modelsync-plugin] 🗄 备份 ${bak}`);
  return bak;
}

/**
 * 把 web 的托管块并集补齐进本 profile；已一致则一个字节都不写。
 * @returns {{action:string, blocks?:string[], to?:string, from?:string, reason?:string}}
 */
export function syncOwnProfileFromWeb({
  log = () => {},
  profileDir = detectOwnProfileDir(),
  webPath = webPatchPath(),
  env = process.env,
  dryRun = false,
} = {}) {
  if (env.MODELSYNC_DISABLE === '1') return { action: 'disabled' };
  if (!profileDir) return { action: 'no-profile' };
  if (basename(profileDir) === 'web') return { action: 'is-web' };
  const patchPath = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(patchPath)) return { action: 'no-patch', reason: patchPath };
  if (!existsSync(webPath)) return { action: 'no-web', reason: webPath };

  const selfText = readFileSync(patchPath, 'utf8');
  const webText = readFileSync(webPath, 'utf8');
  const selfSig = nonManagedSignature(selfText);

  const blocks = [];
  for (const id of MANAGED_BLOCKS) {
    const wb = blockOf(webText, id);
    if (!wb) continue;
    const sb = blockOf(selfText, id);
    if (!sb) {
      blocks.push({ id, lines: trimTrailingBlank(wb.lines) });
      continue;
    }
    const selfLines = trimTrailingBlank(sb.lines);
    const merged = trimTrailingBlank(mergeAdditive(selfLines, trimTrailingBlank(wb.lines)));
    if (norm(merged.join('\n')) !== norm(selfLines.join('\n'))) blocks.push({ id, lines: merged });
  }
  if (!blocks.length) return { action: 'in-sync' };

  const nextText = applyBlocks(selfText, blocks);
  if (nonManagedSignature(nextText) !== selfSig) {
    log('[modelsync-plugin] ⛔ 非托管部分会被改动，放弃写入');
    return { action: 'refused' };
  }
  if (dryRun) return { action: 'would-write', blocks: blocks.map((b) => b.id), from: webPath, to: patchPath };

  backupOnce(patchPath, log, env);
  atomicWrite(patchPath, nextText);
  log(`[modelsync-plugin] ✅ 已从 web 补齐 ${blocks.map((b) => b.id).join(' / ')} → ${patchPath}`);
  return { action: 'written', blocks: blocks.map((b) => b.id), from: webPath, to: patchPath };
}

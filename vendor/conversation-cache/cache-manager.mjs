#!/usr/bin/env node
// conversation-cache — 对话缓存管理工具
//
// 用法:
//   node cache-manager.mjs append <raw-file> "<jsonl-line>"    # 追加原始消息
//   node cache-manager.mjs summarize [--since-days N]          # 生成摘要
//   node cache-manager.mjs list-summaries                      # 列出最近摘要
//   node cache-manager.mjs get-recent [N]                      # 获取最近 N 份摘要内容（用于注入）
//   node cache-manager.mjs clear-old [--keep N]                # 清理旧摘要，保留 N 份
//   node cache-manager.mjs raw-list                            # 列出所有原始对话文件
//   node cache-manager.mjs raw-get <raw-file>                  # 读取原始对话文件

import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { listSessionFiles, readSessionEvents } from './dsh-log-reader.mjs';
import { summarizeEvents } from './summarizer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname);
// 程序自身所在目录（用于找 dsh-log-reader 等同级模块）—— **永远不变**。
const SELF_RAW_DIR = join(CACHE_DIR, 'raw');

// ── ⭐ 记忆根目录：由**调用方**决定，不写死（2026-09-19 用户定死）───────────
//
// 用户原话：「不是都要独立吗，以后还有项目啊，所有设定不要硬编码，不要固定，
//            你是程序员，要长远考虑，不要应付」
//
// 背景：DSH 下每个项目（BOT / TG / 未来的）**各自独立**，记忆也各存各的。
//   本文件是**共享程序**（谁都能调），所以它不能假设"记忆就在我旁边"。
//
// 解析顺序（先具体后笼统）：
//   1. `--memory-dir <路径>` 命令行参数   ← 最明确，按次指定
//   2. `DSH_MEMORY_DIR` 环境变量          ← 项目在自己 .env 里设，全局生效
//   3. 本文件所在位置反推（`<x>/memory/conversation-cache/` → `<x>/memory/`）
//      ← 兼容旧调用方（过去的 TG/Web 都是这个布局），保证不破坏现状
const MEMORY_ARG = (() => {
  const i = process.argv.indexOf('--memory-dir');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const MEMORY_ROOT = (() => {
  if (MEMORY_ARG) return MEMORY_ARG;
  if (process.env.DSH_MEMORY_DIR) return process.env.DSH_MEMORY_DIR;
  // 默认：`.../memory/conversation-cache` 的上一级 = `.../memory`
  return dirname(CACHE_DIR);
})();
// 记忆内容（raw / summaries / 流水账 / handoff）一律落在 MEMORY_ROOT 下。
// ⚠️ 只有 `raw/` 是"记忆数据"，程序代码 (`cache-manager.mjs` 自身) 永远在 CACHE_DIR。
const RAW_DIR = join(MEMORY_ROOT, 'conversation-cache', 'raw');
const SUMMARY_DIR = join(MEMORY_ROOT, 'conversation-cache', 'summaries');
const HANDOFF_DIR = join(MEMORY_ROOT, 'handoff');

// 输出永远是单一摘要文件（最新覆盖旧的）。
const LATEST_SUMMARY_FILE = 'summary.md';
const LATEST_SUMMARY_PATH = join(SUMMARY_DIR, LATEST_SUMMARY_FILE);

// ── 流水账（用户 2026-09-16 定死的设计）──────────────────────
// 定位：只记「用户 ↔ 助手」的对话原文，只增不删（与摘要的「单份覆盖」相反）。
// 用途：平时只用摘要；摘要想不起具体事情时，才来翻流水账查证。
// 存放：raw/ledger/ 下**按月一个文件**，纯追加，永不覆盖。
//
// ⚠️ 2026-09-17 用户定死：文件名用**纯年月**（`2026-09.md`），不再带 chat id 前缀。
//    原文件名形如 `<chatId>-dialogue.md`，那段数字是 chat id；但 TG 与微信走的是
//    **同一个 chatId**（bot.js 四处 ledgerRecord 都传 state.ownerUserId），
//    所以前缀纯属多余，用户明确要求去掉。
const LEDGER_DIR = join(RAW_DIR, 'ledger');

/** 按「年月」算流水账文件名，如 `2026-09.md`。d 可传任意 Date（用于跨月回看）。 */
function ledgerFileFor(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}.md`;
}

/** 上个月的年月文件名（当前月账本不足时，倒回去找）。 */
function prevLedgerFile(d = new Date()) {
  return ledgerFileFor(new Date(d.getFullYear(), d.getMonth() - 1, 1));
}

/**
 * 列出 ledger/ 下所有月度账本，**新的在前**（如 ['2026-09.md','2026-08.md']）。
 * 只认 `YYYY-MM.md` 严格格式，避免把归档/临时文件误当账本。
 */
function listLedgerFiles() {
  try {
    return readdirSync(LEDGER_DIR)
      .filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * 解析流水账路径：默认给「当前月」，若不给具体文件则返回**最新一份存在的**账本，
 * 一份都没有时返回当前月路径（写入时会新建）。
 * @param {string} [chatId] 兼容旧调用签名，已不参与文件名（保留仅为不破坏 CLI 参数）
 */
function resolveLedgerPath(chatId) {
  void chatId; // 显式忽略：文件名不再含 chat id（2026-09-17 定死）
  const cur = join(LEDGER_DIR, ledgerFileFor());
  if (existsSync(cur)) return cur;
  const all = listLedgerFiles();
  if (all.length > 0) return join(LEDGER_DIR, all[0]);
  return cur;
}

// ─── 工具函数 ──────────────────────────────────────────────

function ensureDir(dir) {
  try { readdirSync(dir); } catch { mkdirSync(dir, { recursive: true }); }
}

function nowISO() { return new Date().toISOString(); }

/** 本地可读时间戳，用于流水账行首（人翻账时看这个，不用 ISO）。 */
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function sortedFiles(dir, glob = '*') {
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl') || f.endsWith('.md'));
    if (glob === '*') return files.sort();
    // 把简单 glob 转成合法正则（旧的 new RegExp('*.md') 会抛异常被吞，导致永远返回空）
    const rx = new RegExp(
      '^' + glob.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
    );
    return files.filter(f => rx.test(f)).sort();
  } catch { return []; }
}

// ─── append: 追加原始消息（每行一个 JSON）─────────────────────

function cmdAppend(rawFile, ...lines) {
  ensureDir(RAW_DIR);
  const rawPath = join(RAW_DIR, rawFile.endsWith('.jsonl') ? rawFile : `${rawFile}.jsonl`);
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 如果一行包含多个 JSON（用空格分隔），拆成多行
    const parts = [];
    let remaining = trimmed;
    while (remaining) {
      try {
        const obj = JSON.parse(remaining);
        parts.push(JSON.stringify(obj));
        break;
      } catch {
        // 尝试截断到最近的 }
        const lastBrace = remaining.lastIndexOf('}');
        if (lastBrace > 0) {
          parts.push(JSON.stringify(JSON.parse(remaining.slice(0, lastBrace + 1))));
          remaining = remaining.slice(lastBrace + 1).trim();
        } else {
          break;
        }
      }
    }
    for (const p of parts) {
      appendFileSync(rawPath, p + '\n');
    }
  }
  
  console.log(`✅ 已追加到 ${rawPath}`);
}

// ─── summarize: 从原始对话生成摘要 ──────────────────────────

function cmdSummarize(sinceDays = 7) {
  ensureDir(SUMMARY_DIR);
  
  // 读取原始文件
  // 直接读取 raw 目录下的所有 jsonl 文件
  let rawFiles;
  try {
    rawFiles = readdirSync(RAW_DIR).filter(f => f.endsWith('.jsonl')).sort();
  } catch { rawFiles = []; }
  if (rawFiles.length === 0) {
    console.log('ℹ️ 没有原始对话文件可摘要');
    return;
  }

  // 按日期分组消息
  const grouped = {};
  for (const f of rawFiles) {
    try {
      const content = readFileSync(join(RAW_DIR, f), 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim());
      
      // 从 JSONL 行中提取消息
      let sessionLabel = f.replace('.jsonl', '');
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          
          // 提取关键信息
          if (msg.role === 'user' || msg.role === 'human') {
            const content = msg.content || '';
            const preview = typeof content === 'string' 
              ? content.slice(0, 200).replace(/\n/g, ' ')
              : JSON.stringify(content).slice(0, 200);
            
            if (!grouped[sessionLabel]) grouped[sessionLabel] = [];
            grouped[sessionLabel].push({
              role: msg.role,
              preview: preview,
              timestamp: msg.timestamp || nowISO()
            });
          } else if (msg.role === 'assistant' || msg.role === 'ai') {
            const content = msg.content || '';
            const preview = typeof content === 'string' 
              ? content.slice(0, 300).replace(/\n/g, ' ')
              : JSON.stringify(content).slice(0, 300);
            
            if (!grouped[sessionLabel]) grouped[sessionLabel] = [];
            grouped[sessionLabel].push({
              role: msg.role,
              preview: preview,
              timestamp: msg.timestamp || nowISO()
            });
          }
        } catch { /* 非 JSON 行跳过 */ }
      }
    } catch (e) {
      console.warn(`⚠️ 读取 ${f} 失败: ${e.message}`);
    }
  }

  // 生成摘要 —— 固定单一文件，覆盖写入（用户 2026-09-16 定死的设计）。
  // 历史教训：本函数曾经写 `${today}-summary.md`，每天堆一个新文件、从不覆盖，
  // 与「一个文件、循环覆盖」的设计相悖。已删除该路径，只保留单文件覆盖。
  let summary = `> 本文件由 DSH 会话日志自动归纳生成（单份覆盖）。\n`;
  summary += `> 生成时间：${nowISO()}\n\n`;
  summary += `# 会话纪要（raw/ 简单链路）\n\n`;

  const sessionKeys = Object.keys(grouped).sort();
  if (sessionKeys.length === 0) {
    summary += "没有需要摘要的对话。\n";
    writeFileSync(LATEST_SUMMARY_PATH, summary);
    console.log(`✅ 已覆盖写入: ${LATEST_SUMMARY_FILE}`);
    return;
  }

  for (const key of sessionKeys) {
    const msgs = grouped[key];

    // 提取关键话题（用户消息的摘要）
    const userTopics = msgs
      .filter(m => m.role === 'user' || m.role === 'human')
      .map(m => `- ${m.preview.slice(0, 150)}`)
      .slice(-10); // 只保留最近 10 条用户消息

    summary += `## 会话: ${key}\n\n`;
    summary += `- **总轮次**: ${msgs.length} 条消息\n`;
    summary += `- **话题概览**:\n${userTopics.join('\n') || '  (无用户消息)'}\n\n`;

    // 提取工具调用摘要
    const toolCalls = msgs
      .filter(m => m.role === 'assistant' && m.preview.includes('bash'))
      .map(m => `- bash: ${m.preview.slice(0, 120)}`)
      .slice(-5);

    if (toolCalls.length > 0) {
      summary += `- **关键操作**:\n${toolCalls.join('\n')}\n\n`;
    }
  }

  writeFileSync(LATEST_SUMMARY_PATH, summary);
  console.log(`✅ 已覆盖写入: ${LATEST_SUMMARY_FILE}`);
}

// ─── summarize-v3: 从 DSH 会话日志逐事件归纳，单份覆盖 ────────

/**
 * 读取 DSH v3 会话日志，逐事件归纳后写入唯一摘要文件 summary.md（覆盖旧值）。
 * @param {object} opts
 * @param {string} [opts.sessionId]  只归纳指定会话；缺省归纳"最近变更"的会话。
 * @param {number} [opts.last]       归纳最近 N 个会话（默认只取最新 1 个）。
 */
function cmdSummarizeV3({ sessionId, last = 1 } = {}) {
  ensureDir(SUMMARY_DIR);
  const files = listSessionFiles();
  if (files.length === 0) {
    console.log('ℹ️ 没有找到 DSH 会话日志');
    return false;
  }

  const targets = sessionId
    ? files.filter((f) => f.sessionId === sessionId)
    : files.slice(0, last);
  if (targets.length === 0) {
    console.log(`ℹ️ 没有找到会话 ${sessionId}`);
    return false;
  }

  const parts = [];
  for (const f of targets) {
    const { ok, events, error } = readSessionEvents(f.sessionId);
    if (!ok) {
      console.warn(`⚠️ 读取 ${f.sessionId} 失败: ${error}`);
      continue;
    }
    const md = summarizeEvents(events);
    parts.push(md);
    console.log(`↻ 已归纳 ${f.sessionId}（${events.length} 个事件）`);
  }
  if (parts.length === 0) {
    console.log('ℹ️ 无可归纳的会话');
    return false;
  }

  const combined = parts.join('\n\n---\n\n');
  const header =
    `> 本文件由 DSH 会话日志自动归纳生成（单份覆盖）。\n` +
    `> 生成时间：${nowISO()}\n\n`;
  writeFileSync(LATEST_SUMMARY_PATH, header + combined);
  console.log(`✅ 已覆盖写入 ${LATEST_SUMMARY_FILE}（${(Buffer.byteLength(combined)/1024).toFixed(1)} KB）`);
  return true;
}

// ─── get-latest: 读取唯一摘要（供新会话注入）────────────────

function cmdGetLatest() {
  if (!existsSync(LATEST_SUMMARY_PATH)) {
    console.log('ℹ️ 还没有摘要文件（先用 summarize-v3 生成）');
    return;
  }
  const content = readFileSync(LATEST_SUMMARY_PATH, 'utf-8');
  console.log(content);
}

// ─── get-recent: 获取最近 N 份摘要（用于注入 prompt）─────────

function cmdGetRecent(n = 3) {
  ensureDir(SUMMARY_DIR);
  const files = sortedFiles(SUMMARY_DIR, '*.md');
  
  if (files.length === 0) {
    console.log('ℹ️ 没有摘要文件');
    return;
  }

  // 取最近 N 份
  const recent = files.slice(-n);
  
  for (const f of recent) {
    try {
      const content = readFileSync(join(SUMMARY_DIR, f), 'utf-8');
      console.log(`\n--- ${f} ---`);
      console.log(content);
    } catch (e) {
      console.warn(`⚠️ 读取 ${f} 失败: ${e.message}`);
    }
  }
}

// ─── list-summaries: 列出所有摘要文件 ────────────────────────

function cmdListSummaries() {
  ensureDir(SUMMARY_DIR);
  const files = sortedFiles(SUMMARY_DIR, '*.md');
  
  if (files.length === 0) {
    console.log('没有摘要文件');
    return;
  }

  console.log(`找到 ${files.length} 份摘要:\n`);
  for (const f of files) {
    try {
      const stat = statSync(join(SUMMARY_DIR, f));
      const size = (stat.size / 1024).toFixed(1);
      console.log(`  ${f} (${size} KB)`);
    } catch {}
  }
}

// ─── clear-old: 清理旧摘要，只保留最近 N 份 ──────────────────

function cmdClearOld(keep = 5) {
  ensureDir(SUMMARY_DIR);
  const files = sortedFiles(SUMMARY_DIR, '*.md');
  
  if (files.length <= keep) {
    console.log(`✅ 只有 ${files.length} 份摘要，无需清理（保留 ${keep} 份）`);
    return;
  }

  const toDelete = files.slice(0, files.length - keep);
  for (const f of toDelete) {
    try {
      unlinkSync(join(SUMMARY_DIR, f));
      console.log(`  🗑️ 已删除: ${f}`);
    } catch (e) {
      console.warn(`  ⚠️ 删除 ${f} 失败: ${e.message}`);
    }
  }
  console.log(`✅ 已清理 ${toDelete.length} 份旧摘要，保留最近 ${keep} 份`);
}

// ─── raw-list: 列出所有原始对话文件 ──────────────────────────

function cmdRawList() {
  ensureDir(RAW_DIR);
  const files = sortedFiles(RAW_DIR, '*.jsonl');
  
  if (files.length === 0) {
    console.log('没有原始对话文件');
    return;
  }

  console.log(`找到 ${files.length} 份原始文件:\n`);
  for (const f of files) {
    try {
      const stat = statSync(join(RAW_DIR, f));
      const size = (stat.size / 1024).toFixed(1);
      const lines = readFileSync(join(RAW_DIR, f), 'utf-8').split('\n').filter(l => l.trim()).length;
      console.log(`  ${f} (${size} KB, ${lines} 行)`);
    } catch {}
  }
}

// ─── ledger-append: 追加一条对话原文到流水账 ──────────────────
//
// 流水账 = 只记「用户↔助手」对话原文，只增不删。与摘要（单份覆盖）互补：
//   摘要   → 归纳，日常注入，可能丢细节
//   流水账 → 原文，查证时才翻，永不丢
//
// 用法: node cache-manager.mjs ledger-append <role> "<text>" [--chat <id>]
//   role: user | assistant

function cmdLedgerAppend(role, text, chatId = 'default') {
  ensureDir(LEDGER_DIR);
  const roleOk = role === 'user' || role === 'assistant';
  if (!roleOk) {
    console.error(`❌ role 只能是 user 或 assistant，收到: ${role}`);
    return false;
  }
  const clean = String(text ?? '').trim();
  if (!clean) {
    console.error('❌ 内容为空，不记');
    return false;
  }

  // ⚠️ 2026-09-17：文件名 = 纯「年月」（`2026-09.md`），chatId 不再参与。
  //    跨月时这里自然写到新文件，旧月份自动成为历史，无需额外归档动作。
  const file = join(LEDGER_DIR, ledgerFileFor());
  const isNew = !existsSync(file);

  // 多行文本缩进续行，保证「一条 = 一个块」，翻账时好定位。
  const body = clean.split('\n').map((l, i) => (i === 0 ? l : `    ${l}`)).join('\n');
  const who = role === 'user' ? '👤 用户' : '🤖 助手';
  const block = `\n## ${localStamp()}  ${who}\n\n${body}\n`;

  if (isNew) {
    const header =
      `# 对话流水账 · ${ledgerFileFor().replace(/\.md$/, '')}\n\n` +
      `> 只记「用户 ↔ 助手」的对话原文，只增不删。\n` +
      `> 按月一个文件（本文件 = 本月），跨月自动换新文件，旧月份即历史。\n` +
      `> 用途：查证具体事情时来翻这里。\n` +
      `> 开启时间：${nowISO()}\n`;
    writeFileSync(file, header + block);
  } else {
    appendFileSync(file, block);
  }
  console.log(`✅ 已记流水账: ${file}`);
  return true;
}

// ─── resolveChatId: 兼容旧 CLI 参数（--chat 已不参与文件名）────
//
// ⚠️ 2026-09-17 起文件名不再含 chat id（改为按月 `YYYY-MM.md`），
//    本函数保留只为兼容 `--chat <id>` 这个老参数，避免老命令报错。
//    真正决定读哪个文件的是 `resolveLedgerPath()`：当前月 → 没有则最新一份。

function resolveChatId(chatId) {
  return chatId && chatId !== 'default' ? chatId : 'default';
}

// ─── ledger-path: 打印流水账文件路径（供新会话读） ────────────

function cmdLedgerPath(chatId = 'default') {
  void chatId;
  ensureDir(LEDGER_DIR);
  const file = resolveLedgerPath(chatId);
  console.log(file);
  console.log(existsSync(file) ? '存在' : '尚未创建');
  return file;
}

// ─── ledger-tail: 打印流水账末尾 N 行（查证用） ──────────────
//
// 用法: node cache-manager.mjs ledger-tail [N] [--chat <id>]
//   N 可省略，默认 40；--chat 已不参与文件名（按月分文件，兼容保留）。
//
// ⚠️ 跨月行为（2026-09-17）：默认读**最新一个月度账本**。若当月文件末尾不足 N 行，
//    自动接上上个月的尾巴，保证「翻最近 N 行」在月初也有足够内容。

function cmdLedgerTail(n = 40, chatId = 'default') {
  void chatId;
  const files = listLedgerFiles(); // 新 → 旧
  if (files.length === 0) {
    console.log('ℹ️ 流水账尚未创建');
    return false;
  }
  let lines = [];
  for (const f of files) {
    const part = readFileSync(join(LEDGER_DIR, f), 'utf-8').split('\n');
    lines = part.concat(lines); // 旧月的拼在前面
    if (lines.length >= n) break;
  }
  console.log(lines.slice(-n).join('\n'));
  return true;
}

// ─── get-context: 新会话启动时一次性拿到「摘要 + 流水账路径」────
//
// 这是「不忘」的焊点：AGENTS.md 里写死让新会话先跑这条命令，
// 于是摘要自动进上下文，流水账位置也一并知道（查证时去翻）。
//
// ⚠️ 按档位分流（用户 2026-09-16 定死）：
//   local 档窗口只有 32,768（llama-server -c 65536 -np 2 对半劈），
//   而「摘要 27,124 + handoff 20 条约 10,573」= 37,697 tok ≈ 115% 窗口，
//   冷启动就超 compaction 阈值（80% = 26,214），第一句话还没说就被压缩到失忆。
//   所以 **local 档：摘要和 handoff 都不注入**，窗口全留给对话。
//   云端档（qwen / ds，各 1,000,000 窗口）照旧全给。
//
// ⛔ 2026-09-19 修硬编码：原来这里写死 `join(__dirname,'..','..','TG','.state.json')`
//    —— **写死了项目名 `TG`**。BOT（或未来任何项目）调用时会去读 **TG 的档位**，
//    于是"该不该省记忆"判断错了项目。用户原话：「所有设定不要硬编码，不要固定，
//    你是程序员，要长远考虑，不要应付」。
// ✅ 改为：由调用方用 `DSH_STATE_FILE` 指定，或在 `--memory-dir` 同级找 `.state.json`。
const LOCAL_ROUTE_KEY = 'local';

/** 读当前项目的 `.state.json` 拿 routeKey；读不到返回 null（视为非 local，照旧全给）。 */
function readRouteKey() {
  try {
    // 顺序：① 显式指定 ② 记忆目录的兄弟目录里找（记忆与项目同级的常见布局）
    const candidates = [];
    if (process.env.DSH_STATE_FILE) candidates.push(process.env.DSH_STATE_FILE);
    // 记忆根 = <项目>/memory 时，<项目>/.state.json 就是它
    candidates.push(join(MEMORY_ROOT, '..', '.state.json'));
    // 旧 TG 布局：<x>/memory/conversation-cache → <x>/TG/.state.json
    candidates.push(join(CACHE_DIR, '..', '..', 'TG', '.state.json'));

    for (const stateFile of candidates) {
      if (!stateFile || !existsSync(stateFile)) continue;
      const d = JSON.parse(readFileSync(stateFile, 'utf-8'));
      if (typeof d?.routeKey === 'string') return d.routeKey;
    }
    return null;
  } catch {
    return null; // 读不到就按"非 local"处理 —— 宁可多给记忆，不可静默失忆
  }
}

function cmdGetContext(chatId = 'default') {
  const parts = [];
  void chatId; // 文件名按月，不再含 chat id（2026-09-17）

  const routeKey = readRouteKey();
  const skipMemory = routeKey === LOCAL_ROUTE_KEY;

  parts.push('# 记忆上下文（新会话必读）\n');
  parts.push(`> 生成时间：${nowISO()}\n`);
  parts.push(`> 当前档位：\`${routeKey ?? '未知'}\`${skipMemory ? ' —— **local 档：摘要与 handoff 已按策略跳过**（窗口 32,768，留给对话）' : ''}\n`);

  // 流水账按月分文件：报本月路径，并列出所有历史月份（新→旧）
  const ledgerFile = resolveLedgerPath(chatId);
  const allLedgers = listLedgerFiles();

  if (skipMemory) {
    // ⭐ local 档：handoff 不注入，只报流水账路径（要查自己去翻）
    parts.push(`\n## ① 流水账（对话原文，查证时才翻，不要全读）\n`);
    parts.push(`路径：\`${ledgerFile}\`\n`);
    if (existsSync(ledgerFile)) {
      const st = statSync(ledgerFile);
      const lc = readFileSync(ledgerFile, 'utf-8').split('\n').length;
      parts.push(`状态：存在，${lc} 行，${(st.size / 1024).toFixed(1)} KB\n`);
    } else {
      parts.push('状态：尚未创建\n');
    }
    if (allLedgers.length > 1) {
      parts.push(`历史月份（新的在前）：${allLedgers.join('、')}\n`);
    }
    parts.push(`\n## ② 重启前记录 —— 已跳过（local 档）\n`);
    parts.push(`原因：handoff 与对话叠加会超 local 窗口，本档不注入。\n`);
    parts.push(`正文仍在 \`memory/handoff/handoff.md\`，需要时用 read 工具直接读。\n`);

    console.log(parts.join(''));
    return true;
  }

  // ① 流水账位置
  parts.push('\n## ① 流水账（对话原文，查证时才翻，不要全读）\n');
  parts.push(`路径：\`${ledgerFile}\`\n`);
  if (existsSync(ledgerFile)) {
    const stat = statSync(ledgerFile);
    const lineCount = readFileSync(ledgerFile, 'utf-8').split('\n').length;
    parts.push(`状态：存在，${lineCount} 行，${(stat.size / 1024).toFixed(1)} KB\n`);
    parts.push(`提示：需要查证具体事情时用 \`ledger-tail <N>\`，别整份读进来。\n`);
  } else {
    parts.push('状态：尚未创建\n');
  }
  if (allLedgers.length > 1) {
    parts.push(`历史月份（新的在前）：${allLedgers.join('、')}\n`);
  }

  // ② 重启前记录（handoff）—— 固定单份，正文直接注入
  //
  // ⚠️ 用户 2026-09-16 定死：**摘要不再注入**（摘要链路已退役，文件留作备用方案）。
  // 记忆衔接 = handoff 一份（筛选后的近 20 条原文）+ 流水账（只报路径）。
  // ⚠️ 不读流水账正文 —— 流水账只报路径（见 ① 段），要用时再 ledger-tail。
  parts.push('\n## ② 重启前记录（handoff，单份覆盖，已注入正文）\n');
  try {
    const handoffFile = join(HANDOFF_DIR, 'handoff.md');
    if (existsSync(handoffFile)) {
      parts.push(`路径：\`memory/handoff/handoff.md\`\n\n`);
      parts.push(readFileSync(handoffFile, 'utf-8'));
    } else {
      // 兼容：旧版时间戳命名的历史文件（已不再生成，仅报最新一份的位置）。
      const handoffDir = HANDOFF_DIR;
      const files = readdirSync(handoffDir).filter(f => f.endsWith('.md')).sort();
      if (files.length > 0) {
        parts.push(`_(尚无 handoff.md，以下是旧版时间戳文件的最新一份：\`memory/handoff/${files[files.length - 1]}\`)_\n`);
      } else {
        parts.push('_(无)_\n');
      }
    }
  } catch {
    parts.push('_(读取失败)_\n');
  }

  console.log(parts.join(''));
  return true;
}

// ─── raw-get: 读取原始对话文件 ──────────────────────────────

function cmdRawGet(rawFile) {
  ensureDir(RAW_DIR);
  const path = join(RAW_DIR, rawFile.endsWith('.jsonl') ? rawFile : `${rawFile}.jsonl`);
  
  try {
    const content = readFileSync(path, 'utf-8');
    console.log(content);
  } catch (e) {
    console.error(`❌ 读取失败: ${e.message}`);
  }
}

// ─── 主入口 ──────────────────────────────────────────────────

async function main() {
  // ⚠️ `--memory-dir <路径>` 是**全局参数**，可出现在命令前或后
  //    （`--memory-dir X ledger-append ...` 或 `ledger-append ... --memory-dir X`）。
  //    这里先把它摘掉，否则会被当成"未知命令"。
  //    ⚠️ 真正的路径解析在文件顶部的 MEMORY_ARG —— 它直接扫 process.argv，
  //       所以**必须在此过滤之前**就已经算好（顶层 const 先于 main() 执行，没问题）。
  const args = process.argv.slice(2).filter((a, i, arr) => {
    if (a === '--memory-dir') return false;
    if (i > 0 && arr[i - 1] === '--memory-dir') return false;
    return true;
  });
  if (args.length === 0) {
    console.log(`用法: node cache-manager.mjs <command> [args...]

命令:
  append <raw-file> "<jsonl-line>"   追加原始消息到缓存
  summarize [--since-days N]         从 raw/ 简单 jsonl 生成按天摘要（旧链路）
  summarize-v3 [--session <id>] [--last N]  从 DSH v3 会话日志逐事件归纳，覆盖单份 summary.md
  summarize-latest                   归纳最近 1 个会话（summarize-v3 --last 1 的简写）
  get-latest                         打印单份 summary.md（供新会话注入）
  get-recent [N]                     获取最近 N 份摘要内容（用于注入）
  list-summaries                     列出所有摘要文件
  raw-list                           列出所有原始对话文件
  raw-get <raw-file>                 读取原始对话文件
  clear-old --keep N                 清理旧摘要，保留 N 份

示例:
  node cache-manager.mjs append my-session '{"role":"user","content":"你好"}'
  node cache-manager.mjs summarize-v3 --last 3
  node cache-manager.mjs summarize-v3 --session tg-<chatId>-<时间戳>-<随机串>
  node cache-manager.mjs get-latest
  node cache-manager.mjs get-recent 3`);
    return;
  }

  // ⚠️ `--memory-dir` 已在 main() 开头统一摘除，这里不要重复声明 args。
  const cmd = args[0];
  switch (cmd) {
    case 'append': {
      if (args.length < 3) {
        console.error('用法: append <raw-file> "<jsonl-line>" ["<jsonl-line>" ...]');
        process.exit(1);
      }
      cmdAppend(args[1], ...args.slice(2));
      break;
    }
    case 'summarize': {
      const daysArg = args.indexOf('--since-days');
      const sinceDays = daysArg >= 0 ? parseInt(args[daysArg + 1]) || 7 : 7;
      cmdSummarize(sinceDays);
      break;
    }
    case 'get-recent': {
      const n = parseInt(args[1]) || 3;
      cmdGetRecent(n);
      break;
    }
    case 'list-summaries':
      cmdListSummaries();
      break;
    case 'clear-old': {
      const keepArg = args.find(a => a === '--keep');
      const keep = keepArg ? parseInt(args[args.indexOf('--keep') + 1]) || 5 : 5;
      cmdClearOld(keep);
      break;
    }
    case 'summarize-v3': {
      const sidArg = args.indexOf('--session');
      const lastArg = args.indexOf('--last');
      const sessionId = sidArg >= 0 ? args[sidArg + 1] : undefined;
      const last = lastArg >= 0 ? parseInt(args[lastArg + 1]) || 1 : 1;
      cmdSummarizeV3({ sessionId, last });
      break;
    }
    case 'summarize-latest':
      cmdSummarizeV3({ last: 1 });      break;
    case 'get-latest':
      cmdGetLatest();
      break;
    case 'raw-list':
      cmdRawList();
      break;
    case 'raw-get': {
      if (args.length < 2) {
        console.error('用法: raw-get <raw-file>');
        process.exit(1);
      }
      cmdRawGet(args[1]);
      break;
    }
    case 'ledger-append': {
      if (args.length < 3) {
        console.error('用法: ledger-append <user|assistant> "<text>" [--chat <id>]');
        process.exit(1);
      }
      const chatArg = args.indexOf('--chat');
      const chatId = chatArg >= 0 ? args[chatArg + 1] : 'default';
      cmdLedgerAppend(args[1], args[2], chatId);
      break;
    }
    case 'ledger-path': {
      const chatArg2 = args.indexOf('--chat');
      cmdLedgerPath(chatArg2 >= 0 ? args[chatArg2 + 1] : 'default');
      break;
    }
    case 'ledger-tail': {
      const chatArg3 = args.indexOf('--chat');
      const chatId3 = chatArg3 >= 0 ? args[chatArg3 + 1] : 'default';
      cmdLedgerTail(parseInt(args[1]) || 40, chatId3);
      break;
    }
    case 'get-context': {
      const chatArg4 = args.indexOf('--chat');
      cmdGetContext(chatArg4 >= 0 ? args[chatArg4 + 1] : 'default');
      break;
    }
    default:
      console.error(`❌ 未知命令: ${cmd}`);
      console.log('运行 "node cache-manager.mjs" 查看用法');
      process.exit(1);
  }
}

main().catch(e => {
  console.error('❌ 执行失败:', e.message);
  process.exit(1);
});

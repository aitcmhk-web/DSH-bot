#!/usr/bin/env node
/**
 * Telegram ⇄ DeepSeek Harness bridge.
 *
 * Each Telegram chat gets its own persistent DSH session. Incoming messages are
 * queued as prompts on that session; the harness event stream is turned into a
 * live progress message that becomes the final answer.
 *
 * Run with:  node bot.js
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { loadEnv, parseIdList, ROOT } from './env.js';

// BOT 自己的目录（绝对路径）。用于 spawn 子进程时指定 cwd —— 必须是 BOT 自己，
// 不能用写死的 '/Users/tcm/DSH/BOT'，否则整体搬家后立刻失效。
const APP_DIR = ROOT;
import { DshRuntime } from './dsh.js';
import { Telegram, splitMessage, sendRichTo, markdownToHtml, htmlIsBalanced } from './telegram.js';
import { Weixin, extractText, extractVoiceText, isUserMessage, WX_ITEM_TYPE } from './weixin.js';
import { transcribe as asrTranscribe } from './asr.js';
// ⚠️ 指向**共享**记忆模块 `DSH/memory/`（不是 BOT 自己的副本）——
//    两份内容虽相同，但各存一份迟早改一份忘另一份，且 import 路径要与
//    MEMORY_DIR（handoff / 流水账）保持一致，否则"记忆"概念被劈成两半。
import { classifyUserText } from '../memory/conversation-cache/summarizer.mjs';
import {
  ROUTES,
  DEFAULT_ROUTE_KEY,
  routeByKey,
  routeFor,
  describeRoute,
  isRouteFailure,
  reasoningEffortFor,
} from './models.js';

// ⚠️ 必须在 loadEnv() **之前**拿到 .env 的原始值做快照。
// 原因（2026-09-19 实测踩坑）：env.js 的规则是「真实环境变量优先于 .env」，
// 而 BOT 常常是从**别的 DSH 会话**里启动的（那些会话 export 了整套 HARNESS_*），
// 于是外部环境把 .env 里 BOT 自己的配置**悄悄覆盖掉**：
//   实测 HARNESS_WORKSPACE 被外来值污染成 /Users/tcm/DSH（应为 BOT/），
//   子进程 cwd 跟着跑偏，BOT 的 agent 就去看 TG 的目录了 —— 正是「项目间串味」。
// BOT 自己的配置必须由 BOT 自己说了算，不受「谁启动它」影响。
const ENV_FILE_RAW = loadEnv();
// ⚠️ 这里**只**强制 BOT 自己的目录类配置，**不含 HARNESS_HOME**：
//    HARNESS_HOME 必须保持 ~/.dsh（模型凭据 `$DSH_HOME/.credentials.yaml` 在那，
//    是「模型只有一份、web 端统一管」的单一事实源）。见 .env 末尾的详细说明。
// ⚠️ 也不含 HARNESS_BIN：那个键走另一套规则 —— bot.sh 会解析出 dsh 的**绝对路径**并
//    export（PATH 里没有 dsh 时这是唯一能起子进程的办法，见 bot.sh:122-131），
//    而 .env 里写的是裸的 "dsh"。强行用 .env 覆盖会把 bot.sh 的努力抹掉 → 找不到 dsh。
for (const key of ['HARNESS_WORKSPACE', 'HARNESS_PROFILE']) {
  if (ENV_FILE_RAW[key]) process.env[key] = ENV_FILE_RAW[key];
}

// ─── 流水账（用户 2026-09-16 定死的设计）─────────────────────
//
// 只记「用户 ↔ 助手」的对话原文，只增不删；与摘要（单份覆盖）互补：
//   摘要   → 归纳，日常靠它，可能丢细节
//   流水账 → 原文，查证时才翻，永不丢
//
// 落盘走 conversation-cache 的 cache-manager.mjs（同一套记忆系统，不另造轮子）。
// ⚠️ 必须 fire-and-forget 且吞掉一切异常：记流水账绝不能拖慢或搞崩主对话流程。
//
// ⚠️ 2026-09-17 用户定死：**按月一个文件，文件名 = 纯年月**（`2026-09.md`），
//    不再带 chat id 前缀。因为 TG 与微信传的是**同一个 chatId**（都走 state.ownerUserId），
//    那个数字前缀从来没起过区分作用。命名规则必须与 cache-manager.mjs 的
//    `ledgerFileFor()` **保持一致** —— 两处各写一份是因为 bot 用 spawn 调 CLI、
//    没共享模块；改任一处务必同步另一处。
// ⛔ 更正我 2026-09-19 早先的错误设计（原话：「记忆全落在 BOT/ 内部，不与 TG/DSH 共享」）：
//    那是**错的**，会导致 BOT 的 handoff 和流水账写进 `BOT/memory/` 后**没人读** ——
//    冷启动命令 `memory/conversation-cache/cache-manager.mjs get-context` 按自己的
//    相对路径只认 **`DSH/memory/`**，于是「重启后接不上记忆」。
//    实测证据（2026-09-19）：`DSH/memory/.../2026-09.md` 705KB，`BOT/memory/.../2026-09.md` 仅 1.2KB。
//    ✅ 正解：**记忆目录由项目自己决定，不写死**。BOT 用自己的 `BOT/memory/`，
//    调用共享程序时把路径传过去（`cache-manager.mjs --memory-dir <路径>`）。
//    TG / 未来项目各用各的，互不干扰，也不会"写了一份没人读的"。
//
// ⚠️ 记忆目录 ≠ 工作目录：`config.workspace` 是 **DSH 子进程的 cwd**（必须 BOT/），
//    两者概念不同，但 BOT 恰好都落在 `BOT/` 下。
const MEMORY_DIR = process.env.HARNESS_MEMORY_DIR?.trim() || join(ROOT, 'memory');
const LEDGER_DIR = join(MEMORY_DIR, 'conversation-cache', 'raw', 'ledger');
// ⚠️ **程序**（共享）与**数据**（本项目独占）是两个东西：
//   `MEMORY_SCRIPT` = 那份共享的 cache-manager.mjs（工具代码，所有项目共用一份）
//   `MEMORY_DIR`    = 本项目的数据落点（BOT 自己一份，TG 自己一份）
//   调用时必须显式传 `--memory-dir MEMORY_DIR`，否则程序会按自己的位置猜。
const MEMORY_SCRIPT = process.env.HARNESS_MEMORY_SCRIPT?.trim()
  || join(ROOT, '..', 'memory', 'conversation-cache', 'cache-manager.mjs');

/** 月度文件名，如 `2026-09.md`。d 可传任意日期（用于跨月回看）。 */
function ledgerMonthFile(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}.md`;
}

/** 本月账本绝对路径（不存在也照返回，调用方自己 existsSync）。 */
function ledgerPathFor(d = new Date()) {
  return join(LEDGER_DIR, ledgerMonthFile(d));
}

/**
 * 读账本正文：优先本月；本月不存在则回退**最新的历史月份**。
 * 为什么要回退：月初第一天的会话里，本月文件可能还没创建，
 * 直接读会得到"文件不存在" → handoff 写出「无法提取」的空壳。
 */
function readLedgerText(d = new Date()) {
  const cur = ledgerPathFor(d);
  if (existsSync(cur)) return readFileSync(cur, 'utf8');
  try {
    const all = readdirSync(LEDGER_DIR)
      .filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
      .sort()
      .reverse();
    for (const f of all) {
      const p = join(LEDGER_DIR, f);
      if (existsSync(p)) return readFileSync(p, 'utf8');
    }
  } catch {
    /* 目录不存在等 → 交给调用方按"读不到"处理 */
  }
  return null;
}

/**
 * 记一条流水账（fire-and-forget）。
 * @param {'user'|'assistant'} role
 * @param {string} text
 * @param {number|string} [chatId] 仅作日志/兼容用；文件名按月，不再含 chat id
 */
function ledgerRecord(role, text, chatId) {
  try {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    // ⚠️ 两件事要分开看（2026-09-19 修）：
    //   ① **程序**（cache-manager.mjs）是共享的 → 从 MEMORY_SCRIPT 找
    //      （BOT 自己目录里没有这份程序，别去 BOT/memory/ 找）
    //   ② **数据**（流水账）落在 `MEMORY_DIR` → 用 `--memory-dir` 显式传给程序
    // 旧代码把两者混为一谈（程序和数据都从 ROOT/memory 找），结果数据写进了
    // 别的项目读不到的地方。
    if (!existsSync(MEMORY_SCRIPT)) return; // 记忆系统不在（如换机）→ 静默跳过，不影响对话
    const child = spawn(
      process.execPath, // 用当前 node，避免 PATH 里没有 node
      [MEMORY_SCRIPT, 'ledger-append', role, clean,
       '--chat', String(chatId ?? 'default'),
       '--memory-dir', MEMORY_DIR],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch (err) {
    console.error(`[ledger] 记账失败(已忽略,不影响对话): ${err.message}`);
  }
}

// NOTE: the harness treats every `DSH_*` name as bootstrap-only and *refuses to
// start* when it finds one in a `.env` it reads (the agent's working directory,
// or the harness home). This file lives in TG/, one level below the default
// workspace, so the harness does not read it today — but pointing
// HARNESS_WORKSPACE at TG/ would change that. `HARNESS_` keeps the bot safe
// either way; the names are translated when the child process is spawned.
//
// ⚠️ `MEMORY_DIR` 已在文件上方（LEDGER_DIR 旁边）定义 —— **别在这里重复定义**。

const config = {
  token: (process.env.TELEGRAM_BOT_TOKEN ?? '').trim(),
  allowedUsers: parseIdList(process.env.TELEGRAM_ALLOWED_USER_IDS),
  workspace: (process.env.HARNESS_WORKSPACE ?? '').trim() || ROOT,
  provider: (process.env.HARNESS_PROVIDER ?? '').trim() || 'deepseek-official',
  model: (process.env.HARNESS_MODEL ?? '').trim() || 'deepseek-flash',
  defaultRouteKey: (process.env.HARNESS_MODEL_ROUTE ?? '').trim(),
  reasoningEffort: (process.env.HARNESS_REASONING_EFFORT ?? '').trim() || undefined,
  // ⛔ 权限模式**不是**本文件能控制的东西，所以刻意不在这里留开关。
  // 曾经这里读 HARNESS_PERMISSION_MODE（兜底 'workspace-write'），并由 dsh.js 注入
  // 子进程的 DSH_PERMISSION_MODE —— 但 DSH 全量代码 **0 次读取该变量**（实测 grep 为空），
  // 所以那是个从不生效的死配置，只会让人误以为 bot 在管权限。
  // 真正的权限来自 `~/.dsh/settings.yaml` 的 `permission.defaultPreset`
  // （preset = 沙箱模式 + 审批策略；当前 danger-full-access = 全盘可写 + 无审批）。
  // 要改权限：改 settings.yaml 或运行时用 `/permission`，**别在 .env 里加回这个键**。
  bin: (process.env.HARNESS_BIN ?? '').trim() || 'dsh',
  profile: (process.env.HARNESS_PROFILE ?? '').trim() || 'bot',
  dshHome: (process.env.HARNESS_HOME ?? '').trim() || undefined,
};

if (!config.token) {
  console.error(
    '\n缺少 TELEGRAM_BOT_TOKEN。\n' +
      '请把 .env.example 复制成 .env,并填入 @BotFather 给你的 token。\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Persistent state: which Telegram user owns the bot, and each chat's session.
// ---------------------------------------------------------------------------

const STATE_FILE = join(ROOT, '.state.json');

function loadState() {
  const blank = () => ({
    ownerUserId: null,
    chats: {},
    routeKey: null,
    lastUpdateId: null,
    inFlight: null,
  });
  if (!existsSync(STATE_FILE)) return blank();
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      ownerUserId: parsed.ownerUserId ?? null,
      chats: parsed.chats ?? {},
      routeKey: parsed.routeKey ?? null,
      // The newest Telegram update we actually consumed. Persisted so a restart
      // resumes from there instead of silently discarding whatever was sent
      // while we were down. NOTE: this loader is a whitelist — a field missing
      // here is dropped on the next save.
      lastUpdateId: Number.isSafeInteger(parsed.lastUpdateId) ? parsed.lastUpdateId : null,
      // A turn that was running when the process died. Cleared in runPrompt's
      // `finally`. See `warnAboutLostTurn()` for why this is advisory only.
      inFlight:
        parsed.inFlight && typeof parsed.inFlight === 'object' ? parsed.inFlight : null,
    };
  } catch (err) {
    console.error(`[state] ignoring unreadable ${STATE_FILE}: ${err.message}`);
    return blank();
  }
}

const state = loadState();

// ---------------------------------------------------------------------------
// Model route. The SDK fixes provider/model at `initialize` and offers no way
// to change it later, so a route only changes by rebooting the DSH child.
// Precedence: last /model choice (.state.json) → HARNESS_MODEL_ROUTE →
// the HARNESS_PROVIDER/HARNESS_MODEL pair → the built-in default.
// ---------------------------------------------------------------------------

/** The ad-hoc route a `.env` provider/model pair describes, if it matches none. */
function customRoute() {
  if (!config.provider || !config.model) return null;
  if (routeFor(config.provider, config.model)) return null;
  if (config.provider === 'deepseek-official' && config.model === 'deepseek-flash') return null;
  return {
    key: 'custom',
    label: `自定义 ${config.provider}/${config.model}`,
    short: '自定义',
    provider: config.provider,
    model: config.model,
  };
}

/** Routes /model offers: the built-ins, plus a custom one when `.env` needs it. */
const routeChoices = (() => {
  const custom = customRoute();
  return custom ? [...ROUTES, custom] : [...ROUTES];
})();

let activeRoute =
  routeByKey(state.routeKey ?? '') ??
  routeByKey(config.defaultRouteKey) ??
  routeFor(config.provider, config.model) ??
  customRoute() ??
  routeByKey(DEFAULT_ROUTE_KEY);

function saveState() {
  try {
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`[state] save failed: ${err.message}`);
  }
}

/**
 * 把一段文本拼到 contentBlocks 的**第一个 text block 前面**；
 * 若没有 text block，就插到最前面。
 *
 * 为什么要这个而不是简单 unshift：图片 block 在 DSH 侧是有顺序语义的
 * （"看这张图"），把记忆前言插到图片**前面**会让指代错位。
 * 而拼在文字开头则天然是"背景说明 + 用户正文"，最自然。
 */
function prependTextBlock(contentBlocks, prefix) {
  const arr = Array.isArray(contentBlocks) ? [...contentBlocks] : [];
  if (!prefix) return arr;
  const i = arr.findIndex((b) => b?.type === 'text');
  if (i >= 0) {
    arr[i] = { ...arr[i], text: `${prefix}${arr[i].text ?? ''}` };
    return arr;
  }
  return [{ type: 'text', text: prefix }, ...arr];
}

function newSessionId(chatId) {
  return `tg-${chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sessionFor(chatId) {
  const key = String(chatId);
  state.chats[key] ??= { sessionId: newSessionId(key), createdAt: Date.now() };
  return state.chats[key];
}

function resetSession(chatId) {
  const key = String(chatId);
  const record = { sessionId: newSessionId(key), createdAt: Date.now() };
  state.chats[key] = record;
  saveState();
  return record;
}

/**
 * ⭐ 冷启动记忆自动注入（2026-09-19 新增，用户点名的问题）。
 *
 * 背景（为什么需要这个）：
 *   handoff 机制一直是**通的** —— `/restart` 会写 `memory/handoff/handoff.md`，
 *   `cache-manager.mjs get-context` 也确实会把它的正文注入。但**注入的触发
 *   全靠 agent 自觉执行那条命令**（LITE.md / AGENTS.md 里写着"冷启动必跑"）。
 *   一旦 agent 没跑（比如用户只发了个「1」），handoff 就静默失效 ——
 *   **写了等于没写，而且完全不报错**。这是"路径写错"之外的第二种静默失效。
 *
 * 本函数的职责：把"靠自觉"变成"机制保证" ——
 *   **新会话的第一条 prompt 之前，自动把 get-context 的输出作为前言附上。**
 *
 * ⚠️ 只在新会话的**第一条**消息注入（用 sessionRecord.bootstrapped 标记），
 *    不是每轮都注入 —— 否则历史上下文里会堆满重复的 handoff。
 * ⚠️ 失败一律降级：拿不到就照原样发，绝不因为记忆系统坏了而挡住对话
 *    （与 ledgerRecord() 同一条原则）。
 */
function memoryBootstrapPrefix(chatId) {
  try {
    if (!existsSync(MEMORY_SCRIPT)) return ''; // 记忆系统不在（换机）→ 静默跳过
    const out = execFileSync(
      process.execPath,
      [MEMORY_SCRIPT, 'get-context', '--chat', String(chatId ?? 'default'),
       '--memory-dir', MEMORY_DIR],
      { encoding: 'utf-8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const body = String(out ?? '').trim();
    if (!body) return '';
    return (
      '<冷启动记忆（系统自动注入，无需回复此段）>\n' +
      body +
      '\n</冷启动记忆>\n\n'
    );
  } catch (err) {
    console.error(`[mem] 冷启动记忆注入失败(已忽略,不影响对话): ${err.message}`);
    return '';
  }
}

/**
 * 取本会话的"开场白"：仅当这是该 sessionId 的**第一条** prompt 时返回记忆前言，
 * 否则返回空串。调用方负责把它拼到用户消息前面。
 *
 * ⚠️ 标记存在 `state.chats[key].bootstrapped`（存盘持久化）——
 *    这样进程重启后若 sessionId 没变（续用旧会话），不会重复注入。
 *    sessionId 变了（/new、/restart、模型切换）→ 新记录无标记 → 自然再注入一次。
 */
function takeBootstrapPrefix(chatId) {
  const key = String(chatId);
  const record = sessionFor(key);
  if (record.bootstrapped) return '';
  record.bootstrapped = true;
  // ⚠️ saveState() 是白名单式的（loadState 只认列出的字段），
  //    新增字段必须同步加到 loadState() 的白名单里，否则一存盘就被丢掉。
  saveState();
  return memoryBootstrapPrefix(chatId);
}

// ---------------------------------------------------------------------------
// Access control: explicit allow-list, else first-come owner claim.
// ---------------------------------------------------------------------------

function authorize(userId) {
  if (config.allowedUsers.length > 0) {
    if (!config.allowedUsers.includes(userId)) return { ok: false, reason: 'not-allowed' };
    // ⚠️ 白名单通过的同时**也要认领主人锚点**。
    // 原逻辑：白名单分支直接 return，**从不执行下面的认领** →
    //   state.ownerUserId 永远是 null →
    //   ① 微信入口拿到 null 锚点，回「尚未绑定 Telegram 主人」
    //   ② 节点广播「微信入站 → TG」时没有投递目标 → `chat not found`
    //   （2026-09-19 实测，见 bot.log 的 `[hub] 微信入站 → tg 失败: chat not found`）
    // 白名单里的人天然可信（只有他们能通过），认领不会放宽任何权限。
    if (state.ownerUserId === null) {
      state.ownerUserId = userId;
      saveState();
      return { ok: true, claimed: true };
    }
    return { ok: true };
  }
  if (state.ownerUserId === null) {
    state.ownerUserId = userId;
    saveState();
    return { ok: true, claimed: true };
  }
  return state.ownerUserId === userId ? { ok: true } : { ok: false, reason: 'not-owner' };
}

/**
 * 解析「会话锚点」——即 TG 主人的 chat id。微信入口靠它共用同一会话。
 *
 * ⚠️ 为什么不能直接用 state.ownerUserId:authorize() 只在**没有**白名单时才
 * first-come 认主;一旦配置了 TELEGRAM_ALLOWED_USER_IDS(本项目当前就是),
 * 它走白名单分支直接返回,`state.ownerUserId` 永远是 null。
 * 而微信侧发来的 id 是微信 id,不是 TG id,不能当锚点。
 * 所以白名单存在时,锚点 = 白名单里的那个人(私聊里 chat id == user id)。
 */
function resolveOwnerAnchor(fallbackWxUserId) {
  if (state.ownerUserId !== null) return state.ownerUserId;
  if (config.allowedUsers.length > 0) return config.allowedUsers[0];
  return null;
}

// ---------------------------------------------------------------------------
// Live progress message: one chat message that tracks the running turn.
// ---------------------------------------------------------------------------

const TOOL_LABELS = {
  bash: '💻 执行命令',
  read: '📖 读取文件',
  write: '📝 写入文件',
  edit: '✏️ 修改文件',
  glob: '🔍 查找文件',
  grep: '🔍 搜索内容',
  web_search: '🌐 联网搜索',
  web_fetch: '🌐 抓取网页',
  subagent: '🤖 派生一个子代理',
  subagent_fork: '🤖 派生一个子代理',
  todo_write: '📋 更新任务清单',
  present: '📦 交付文件',
  ask_user_question: '❓ 想问你一个问题',
  workflow: '⚙️ 运行工作流',
  create_goal: '🎯 设定目标',
  skill: '🧩 加载技能',
  job_output: '⏳ 等待后台任务',
  job_list: '📋 查看后台任务',
};

function truncate(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function describeTool(name, rawArguments) {
  let args = {};
  try {
    args = JSON.parse(rawArguments || '{}');
  } catch {}
  const hint =
    args.command ??
    args.file_path ??
    args.path ??
    args.pattern ??
    args.query ??
    args.url ??
    args.description ??
    args.objective ??
    '';
  const label = TOOL_LABELS[name] ?? `🔧 ${name}`;
  const detail = truncate(hint, 120);
  return detail ? `${label}\n${detail}` : label;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 吐字速度采样器（2026-09-17 加，TG/微信共用）。
 *
 * SDK 没有逐 token 流式，只有整段 assistant/message 事件，所以拿不到真实
 * token 数——这里按「已生成字符数 / 首字以来的秒数」估算一个 ≈ N 字/秒。
 * 原先这套逻辑内联在 LiveStatus 里，导致**只有 TG 有尾巴**；微信走的是另一条
 * deliver() 路径，既不显示也不落日志。抽出来两边共用同一口径。
 */
class SpeedSampler {
  constructor(label) {
    /** 落日志用的通道标识，如 `tg` / `wx`。 */
    this.label = label;
    /** Epoch ms of the first streamed character of the current turn. */
    this.firstCharAt = null;
    /** 本轮已吐字数（累加）。 */
    this.lastCharCount = 0;
    this.lastCharAt = null;
    /** 整轮起点 = 用户消息进来 / prompt 发出那一刻，用作兜底计时。 */
    this.turnStartedAt = null;
  }

  /** 开新一轮：清零采样，并记下整轮起点（兜底计时用）。 */
  reset() {
    this.firstCharAt = null;
    this.lastCharCount = 0;
    this.lastCharAt = null;
    this.turnStartedAt = Date.now();
  }

  /**
   * 记录一次「已经吐了多少字」的快照，用来算吐字速度。
   * 由 assistant/message 事件调用（整段文本，非增量）。
   *
   * firstCharAt 只在**本轮第一次吐字**时落定，之后任何间隔都不再重置：
   * 一次 turn 里往往夹着工具调用（思考 → 工具 → 再思考），若按"空闲多久就重置"
   * 的算法，最后一段文字几乎没有 elapsed，小尾巴会被静默丢掉。
   * 工具耗时算进均速里是**有意为之** —— 那才是用户真实等待的吐字速度。
   */
  track(charCount) {
    const now = Date.now();
    if (!charCount) return;
    if (this.firstCharAt === null) this.firstCharAt = now;
    this.lastCharAt = now;
    // ⚠️ 累加，不是覆盖。assistantText 在 onSessionEvent 里是整轮覆盖赋值的，
    // 一轮若推了 2 条 assistant/message（思考 → 工具 → 再思考），覆盖会把前面
    // 的字数抹掉 —— 只算最后一段的话 elapsed 往往不足 1 秒，尾巴就被静默丢掉。
    this.lastCharCount += charCount;
  }

  /**
   * 均速的计时段落。
   *
   * ⚠️ 计时起点**必须**是 firstCharAt（本轮第一次吐字），不能是"上一条 assistant/message
   * 的时刻"：SDK 一次 turn 常常只推**一条** assistant/message，那种算法下
   * lastCharAt === prevCharAt，差值恒为 0 → 永远算不出速度。
   *
   * ⚠️ 2026-09-17 修正：SDK 是"整段一次性到达"——track() 落 firstCharAt 的时刻
   * 就是文字到达的时刻，紧接着 finish() 就被调用，elapsed ≈ 0.003s（实测），
   * 会算出 Infinity 或被 `<1s` 判据丢掉。所以：
   *   ① elapsed 取 max(首字起算, 整轮起算) 不可行 —— 首字必然晚于整轮起点；
   *   ② 改为**先按首字算，算出来太小（<1s）就回退到整轮起点**，口径变成
   *      "用户实际等待速度"（含首字延迟 + 工具耗时），宁可偏慢也不出 Infinity。
   */
  window() {
    if (!this.lastCharCount) return null;
    const now = Date.now();
    const MIN_ELAPSED = 1;   // 秒；低于这个数的均速会剧烈跳，没有展示意义
    let from = this.firstCharAt ?? this.turnStartedAt;
    if (from === null) return null;
    let elapsed = (now - from) / 1000;
    if (elapsed < MIN_ELAPSED && this.turnStartedAt !== null) {
      const whole = (now - this.turnStartedAt) / 1000;
      if (whole > elapsed) {
        from = this.turnStartedAt;
        elapsed = whole;
      }
    }
    if (!(elapsed > 0)) return null;   // 兜底：除零/负值一律不显示，绝不吐 Infinity
    return { chars: this.lastCharCount, elapsed, rate: this.lastCharCount / elapsed };
  }

  /**
   * 收尾：落一条采样日志 + 返回要追加到回复末尾的小尾巴。
   *
   * 每轮只调一次（TG 在 LiveStatus.finish()、微信在 deliver()）。
   * 没吐字 / 计时不可用的分支也要留痕，否则"为什么这轮没尾巴"无从查证。
   */
  finish() {
    const endedAt = Date.now();
    const w = this.window();
    const reason = !this.lastCharCount
      ? 'no-chars'
      : this.firstCharAt === null
        ? 'no-first-char'
        : 'ok';
    console.log(
      `[tps] chat=${this.label} ${reason} 首字=${
        this.firstCharAt ? new Date(this.firstCharAt).toISOString() : 'null'
      } 结束=${new Date(endedAt).toISOString()} 耗时=${
        w ? w.elapsed.toFixed(2) : 'null'
      }s 字数=${this.lastCharCount} 速率=${w ? w.rate.toFixed(1) : 'null'}`,
    );
    if (!w) return null;
    return `🚀 ≈${w.rate.toFixed(1)} 字/秒 · 共 ${w.chars} 字`;
  }
}

class LiveStatus {
  constructor(telegram, chatId) {
    this.telegram = telegram;
    this.chatId = chatId;
    this.messageId = null;
    this.notes = [];
    this.startedAt = Date.now();
    this.typingTimer = null;
    this.tickTimer = null;
    this.editTimer = null;
    this.lastRendered = '';
    /** Epoch ms before which Telegram has asked us not to edit again. */
    this.editBlockedUntil = 0;
    /** 进度 edit 连续失败计数；≥3 改走「重发新进度消息」保活（2026-10-06 卡壳观感修复）。 */
    this.editFailStreak = 0;
    this.closed = false;
    /** 吐字速度采样器（2026-09-17 抽出，与微信共用同一口径）。 */
    this.sampler = new SpeedSampler(chatId);
  }

  async begin() {
    try {
      const sent = await this.telegram.sendMessage(this.chatId, '⏳ 正在处理…');
      this.messageId = sent.message_id;
    } catch (err) {
      console.error(`[tg] could not send placeholder: ${err.message}`);
    }
    this.typingTimer = setInterval(() => {
      this.telegram.sendChatAction(this.chatId, 'typing').catch(() => {});
    }, 4500);
    this.typingTimer.unref?.();
    this.tickTimer = setInterval(() => this.#scheduleEdit(), 2000);
    this.tickTimer.unref?.();
    this.telegram.sendChatAction(this.chatId, 'typing').catch(() => {});
  }

  addNote(note) {
    this.notes.push(note);
    if (this.notes.length > 12) this.notes.splice(0, this.notes.length - 12);
    this.#scheduleEdit();
  }

  /** 记录一次吐字快照（委托给共用的 SpeedSampler，TG/微信同一口径）。 */
  trackProgress(charCount) {
    this.sampler.track(charCount);
  }

  /** 开新一轮采样：清零并记下整轮起点。 */
  resetSampler() {
    this.sampler.reset();
  }

  /** 估算的平均吐字速度（字/秒）；数据不足或缺席时返回 null。 */
  #tps() {
    return this.sampler.window();
  }

  /**
   * 最终回复末尾的「小尾巴」+ 每轮一条采样日志，全部由 SpeedSampler.finish() 产出。
   * 只在 finish() 里调一次，所以不会重复刷屏。
   */
  #speedTail() {
    return this.sampler.finish();
  }

  render() {
    const seconds = Math.round((Date.now() - this.startedAt) / 1000);
    const tps = this.#tps();
    let header = `⏳ 正在处理… (${seconds}s)`;
    if (tps) {
      header += `\n🚀 ≈${tps.rate.toFixed(1)} 字/秒 · 已生成 ${tps.chars} 字`;
    }
    const recent = this.notes.slice(-3);
    return recent.length === 0 ? header : `${header}\n\n${recent.join('\n\n')}`;
  }

  #scheduleEdit() {
    if (this.closed || !this.messageId || this.editTimer) return;
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      this.#flush();
    }, 1500);
    this.editTimer.unref?.();
  }

  async #flush() {
    if (this.closed || !this.messageId) return;
    // A 429 carries its own "retry after"; honour it instead of hammering the
    // API (Telegram limits how often one message may be edited).
    if (Date.now() < this.editBlockedUntil) return;
    const text = this.render();
    if (text === this.lastRendered) return;
    // Only remember the text once it actually landed, otherwise a rejected edit
    // would leave the progress message permanently stale.
    if (await this.#safeEdit(text)) {
      this.lastRendered = text;
      return;
    }
    // edit 连续失败 ≥3（抖动链路上常见）：改删旧占位、重发新进度——数字会跳，但不会纹丝不动像死机。
    this.editFailStreak += 1;
    if (this.editFailStreak >= 3) {
      this.editFailStreak = 0;
      try {
        const sent = await this.telegram.sendMessage(this.chatId, text);
        this.messageId = sent.message_id;
        this.lastRendered = text;
        console.error(`[tg] 进度消息 edit 连续失败，已改重发保活 (message_id=${this.messageId})`);
      } catch (err) {
        console.error(`[tg] 进度保活重发也失败: ${err.message}`);
      }
    }
  }

  /** @returns {Promise<boolean>} whether the edit landed. */
  async #safeEdit(text) {
    try {
      await this.telegram.editMessageText(this.chatId, this.messageId, text);
      this.editFailStreak = 0;
      return true;
    } catch (err) {
      if (err.errorCode === 429) {
        const retryAfter = Math.max(1, Number(err.parameters?.retry_after ?? 5));
        this.editBlockedUntil = Date.now() + retryAfter * 1000;
        console.error(`[tg] 进度消息被限流,${retryAfter}s 内不再编辑`);
        return false;
      }
      // Telegram answers 400 "message is not modified" when the text is identical.
      if (!String(err.description ?? err.message).includes('not modified')) {
        console.error(`[tg] edit failed: ${err.message}`);
      }
      return false;
    }
  }

  /**
   * Put the final text in front of the user. Editing the placeholder is
   * preferred, but an edit can be rate-limited or rejected — and losing the
   * answer that way is far worse than one extra message, so fall back to
   * deleting the placeholder and sending a fresh one.
   *
   * 2026-09-13：最终答案走 HTML 格式化（markdown → Telegram HTML）。
   * 进度消息仍用纯文本（见 #safeEdit），因为它是半成品、且高频编辑。
   * 若 HTML 编辑被拒（400/解析错误），退回纯文本路径，绝不丢答案。
   */
  async #deliverFinal(text) {
    try {
      if (this.messageId && (await this.#safeEditRich(text))) return;
      if (this.messageId) {
        try {
          await this.telegram.deleteMessage(this.chatId, this.messageId);
        } catch {}
        this.messageId = null;
      }
      await sendRichTo(this.telegram, this.chatId, text);
    } catch (err) {
      // 这里咽下异常而不是往上抛：上层的兜底只会再发一条「❌ 出错了」，同样会失败，
      // 而且会把异常抛出这一次 turn（可能变成 unhandled rejection）。答案已经丢了，
      // 至少留一条能一眼认出来的日志，并能继续走后面的 hub 广播（微信镜像）。
      console.error(`[tg] ⛔ 最终答案投递失败,用户看不到这条(${text.length} 字): ${err.message}`);
    }
  }

  /** 同 #safeEdit，但把 markdown 转成 Telegram HTML 再编辑；失败回退纯文本。 */
  async #safeEditRich(markdown) {
    const html = markdownToHtml(markdown);
    if (htmlIsBalanced(html)) {
      try {
        await this.telegram.editMessageText(this.chatId, this.messageId, html, {
          parse_mode: 'HTML',
        });
        return true;
      } catch (err) {
        if (err.errorCode === 429) {
          const retryAfter = Math.max(1, Number(err.parameters?.retry_after ?? 5));
          this.editBlockedUntil = Date.now() + retryAfter * 1000;
          console.error(`[tg] 进度消息被限流,${retryAfter}s 内不再编辑`);
          return false;
        }
        // HTML 被拒（400）→ 落到下面的纯文本编辑，保答案
        console.error(`[tg] HTML 编辑失败,回退纯文本: ${err.message}`);
      }
    }
    return this.#safeEdit(markdown);
  }

  #stopTimers() {
    this.closed = true;
    if (this.typingTimer) clearInterval(this.typingTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.editTimer) clearTimeout(this.editTimer);
    this.typingTimer = this.tickTimer = this.editTimer = null;
  }

  async finish(answerText) {
    this.#stopTimers();
    const tail = this.#speedTail();
    const withTail = (text) => (tail ? `${text}\n\n${tail}` : text);
    const body = String(answerText ?? '').trim();
    if (!body) {
      await this.#deliverFinal(withTail('✅ 已完成(本轮没有文字输出)'));
      return;
    }
    const chunks = splitMessage(withTail(body));
    if (chunks.length === 1) {
      await this.#deliverFinal(chunks[0]);
      return;
    }
    if (this.messageId) {
      try {
        await this.telegram.deleteMessage(this.chatId, this.messageId);
      } catch {}
      this.messageId = null;
    }
    // 长回答：sendRichTo 内部做标签感知切分 + htmlIsBalanced 自检 + 400 时降级纯文本，
    // 所以这里不再用裸 sendMessage（那样会丢失 markdown 格式，且切分不当会产生非法 HTML）。
    await sendRichTo(this.telegram, this.chatId, withTail(body));
  }

  async fail(reason) {
    this.#stopTimers();
    await this.#deliverFinal(`❌ 出错了:${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const telegram = new Telegram(config.token);
const weixin = new Weixin();
const runtime = new DshRuntime({
  bin: config.bin,
  profile: config.profile,
  cwd: config.workspace,
  provider: activeRoute.provider,
  model: activeRoute.model,
  reasoningEffort: reasoningEffortFor(activeRoute, config.reasoningEffort),
  dshHome: config.dshHome,
});

/** chatId -> promise chain, so one chat never runs two turns at once. */
const chatQueues = new Map();

function enqueue(chatId, task) {
  const previous = chatQueues.get(chatId) ?? Promise.resolve();
  const next = previous.then(task, task);
  chatQueues.set(
    chatId,
    next.catch(() => {}),
  );
  return next;
}

/**
 * 忙时合包（2026-10-06 用户定，TG 侧专用）：
 * 我正在处理上一条消息时你又连发的几条，不再一条一条各开一轮，
 * 而是先落进信箱，等当前这轮跑完，把积压的几条**合并成一条**投给模型（几条并作一次提问、一次回答）。
 * 我空闲时你发的消息仍然**立刻**处理，零等待 —— 与消息窗口「打包间隔秒」那种固定等候是两回事。
 * 微信侧不动：那边仍走原 enqueue 串行。
 */
const chatMailboxes = new Map(); // chatId -> { running, pending: Array<blocks> }

/** 多条消息合成一份 blocks：相邻文本块用换行拼接；图片等非文本块按原顺序保留。 */
function mergeBlocks(batches) {
  if (batches.length === 1) return batches[0];
  const merged = [];
  for (const part of batches) {
    for (const b of part) {
      const last = merged[merged.length - 1];
      if (b.type === 'text' && last?.type === 'text') last.text = `${last.text}\n${b.text}`;
      else merged.push({ ...b });
    }
  }
  return merged;
}

async function drainMailbox(chatId, box) {
  try {
    while (box.pending.length > 0) {
      const batch = box.pending.splice(0);
      console.log(`[tg] 忙时合包：本轮合并 ${batch.length} 条消息为一次提问`);
      await runPrompt(chatId, mergeBlocks(batch)).catch((err) =>
        console.error(`[tg] 合包轮次失败: ${err.message}`),
      );
    }
  } finally {
    if (box.pending.length === 0) chatMailboxes.delete(chatId);
    else await drainMailbox(chatId, box).catch(() => {}); // 收尾间隙又来了新消息 → 继续清
  }
}

function submitTurn(chatId, blocks) {
  let box = chatMailboxes.get(chatId);
  if (!box) {
    box = { running: false, pending: [] };
    chatMailboxes.set(chatId, box);
  }
  box.pending.push(blocks);
  if (box.running) return; // 忙：先攒着，等当前轮跑完由 drain 合并带走
  box.running = true;
  drainMailbox(chatId, box).catch(() => {});
}

// ---------------------------------------------------------------------------
// Mid-turn crash detection (advisory only)
//
// The polling cursor is persisted when an update is DISPATCHED, not when it is
// answered — handlers are fire-and-forget and a turn can run for minutes. So if
// the process dies mid-turn, Telegram never redelivers that message: the update
// is already confirmed. We cannot fix that without making getUpdates replay the
// whole batch during the turn (see pollLoop), so instead we record that a turn
// was running and tell the owner on the next boot. Losing a message silently is
// the failure this guards against; a duplicate warning is harmless.
// ---------------------------------------------------------------------------

function markTurnInFlight(chatId) {
  state.inFlight = { chatId: String(chatId), startedAt: Date.now() };
  saveState();
}

function clearTurnInFlight(chatId) {
  if (String(state.inFlight?.chatId) !== String(chatId)) return;
  state.inFlight = null;
  saveState();
}

/** Warn the owner if the previous process died while a turn was still running. */
async function warnAboutLostTurn() {
  const stale = state.inFlight;
  if (!stale || state.ownerUserId === null) return;
  clearTurnInFlight(stale.chatId);
  const when = Number.isFinite(stale.startedAt)
    ? new Date(stale.startedAt).toLocaleString('zh-CN', { hour12: false })
    : '未知时间';
  console.error(`[bot] ⚠️ 上次退出时有一条消息仍在处理中(startedAt=${when}),可能已丢失`);
  await telegram
    .sendMessage(
      state.ownerUserId,
      `⚠️ 上次重启时有一条消息还在处理中,它的回复可能没发出来。\n\n` +
        `开始时间:${when}\n` +
        `如果你发过消息但没收到回复,麻烦重发一次。`,
    )
    .catch((err) => console.error(`[bot] 丢失提示发送失败:${err.message}`));
}

/**
 * 启动补写 handoff —— 覆盖「来不及在断开前写」的情况：
 * 重启电脑、launchd 拉起、崩溃自愈、以及用户直接 `./tg.sh restart`。
 *
 * ⚠️ 用户 2026-09-16 定：这类断开**只能事后补**，所以时间戳会晚于真实断开时刻
 * （正文里已注明，见 REASON_TEXT.boot）。
 *
 * ⚠️ 保险（用户点头过的）：**只在 handoff 确实过期时才写** ——
 * 即 handoff 的 mtime 早于流水账最后一条的时间。否则不碰，
 * 避免把刚写好的一份好记忆用同样的内容重写一遍、甚至盖掉更新的。
 */
async function catchUpHandoffOnBoot() {
  try {
    if (state.ownerUserId === null) return; // 还没有主人，没什么可交接的
    const chatId = state.ownerUserId;       // 私聊里 chat id == user id
    const handoffFile = join(MEMORY_DIR, 'handoff', 'handoff.md');
    // 按月账本：读最新一份（本月没有则回看历史月），见 readLedgerText()
    const ledgerText = readLedgerText();
    if (ledgerText === null) return;

    // 流水账最后一条的时间（本地时间格式，与写入端一致）
    // ⚠️ 正则必须用 [ \t]+ 而不是单个空格：写入端是 `## 时间  👤 用户`
    //    （**两个**空格），写 `## 时间 ` 会漏配 → 匹配数恒为 0 → 恒判"已是最新"。
    //    这一字之差让 boot 补写自 2026-09-16 起就没生效过（2026-09-16 实测修复）。
    let lastEntryMs = 0;
    try {
      const heads = ledgerText.match(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[ \t]/gm);
      if (heads && heads.length) {
        const t = heads[heads.length - 1].slice(3).trim();
        lastEntryMs = new Date(t.replace(' ', 'T')).getTime();
      }
    } catch { /* 读不到就当没新内容 */ }
    // ⚠️ 抓不到时间戳时**必须保守地补写**，不能静默 return ——
    //    旧代码 return 的语义是"当作没有新内容"，可真相是"我读不懂流水账"。
    //    两者混淆 ⇒ 解析一坏，补写永久静默失效，而日志还显示一切正常。
    const parseFailed = !Number.isFinite(lastEntryMs) || lastEntryMs === 0;
    if (parseFailed) {
      console.error('[tg] handoff(boot): ⚠️ 流水账末条时间解析失败，改为保守补写');
    }

    const handoffMs = existsSync(handoffFile) ? statSync(handoffFile).mtimeMs : 0;
    if (!parseFailed && handoffMs >= lastEntryMs) {
      console.log('[tg] handoff(boot): 已是最新，跳过补写');
      return;
    }

    const saved = writeHandoff({ chatId, reason: 'boot' });
    if (saved) console.log('[tg] handoff(boot): 补写完成（旧 handoff 早于流水账末条）');
  } catch (err) {
    // 补写失败绝不影响启动 —— 只是记忆旧一点，bot 必须照常服务。
    console.error(`[tg] handoff(boot) failed: ${err.message}`);
  }
}

/**
 * Boot the runtime onto `route` and persist the choice.
 *
 * A fresh runtime cannot resume the previous process's sessions, so every chat
 * is rotated to a fresh id — the same rotation `runPrompt` performs when it sees
 * "already exists" after a bot restart.
 */
async function activateRoute(route, { rotateSessions = true, persist = true } = {}) {
  await runtime.setRoute({
    provider: route.provider,
    model: route.model,
    reasoningEffort: reasoningEffortFor(route, config.reasoningEffort),
  });
  activeRoute = route;
  // A boot-time fallback must stay in memory only: persisting it would make a
  // temporarily broken default sticky, and the next restart would never retry it.
  if (persist) state.routeKey = route.key;
  if (rotateSessions) state.chats = {};
  saveState();
}

/**
 * 自动回退链：按档位表顺序试，但**本地档永远排最后**兜底（README.md:164 的口径）。
 * 生效档位表 web-models.json 由 Web 端同步生成、本地排第一，直接按列表顺序回退
 * 会一挂就先撞本地（2026-09-28 实际发生过：zhipu 余额不足 → 直切 LOCAL-VQ）。
 * 只影响回退顺序；`/model` 菜单的展示顺序不变。
 */
function fallbackChainAfter(brokenKey) {
  const rest = routeChoices.filter((r) => r.key !== brokenKey);
  return [...rest.filter((r) => r.key !== 'local'), ...rest.filter((r) => r.key === 'local')];
}

/** Try `preferred`, then the remaining routes in order (local last), until one boots. */
async function bootFirstWorkingRoute(preferred) {
  const chain = [preferred, ...fallbackChainAfter(preferred.key)];
  const failures = [];
  for (const route of chain) {
    try {
      await activateRoute(route, { rotateSessions: false, persist: false });
      return { route, failures };
    } catch (err) {
      failures.push(`${route.short}: ${err.message}`);
      console.error(`[model] 路由 ${route.key} 启动失败：${err.message}`);
    }
  }
  return { route: null, failures };
}

function modelKeyboard() {
  // ⚠️ 试过的弯路（2026-09-19，别再试）：
  //   Telegram 的 inline 按钮**文字只能居中**，客户端没有左对齐选项。
  //   我试过「把所有按钮补空格到等宽」来模拟左对齐 —— **没用**，
  //   Telegram 会把行尾空格裁掉再渲染，按钮又变回各自的宽度。
  //   结论：放弃追求左对齐，按钮文字就是居中的。
  return {
    inline_keyboard: [
      ...routeChoices.map((route) => [
        {
          // `✅` 放**后缀**，不放前缀 —— 前缀会把那一行文字整体右推，
          // 看起来像其它按钮缩进了（用户原话：「✅ 不要占位对齐的字」）。
          text: `${route.short}${route.key === activeRoute.key ? ' ✅' : ''}`,
          callback_data: `model:${route.key}`,
        },
      ]),
      // 「重启」不放在模型选单里 —— 它是顶层操作,出现在命令列表的
      // 「切换模型」与「查看当前会话」之间(见 setMyCommands 与 /help)。
    ],
  };
}

function modelMenuText() {
  return [
    '🧠 选择模型',
    '',
    `当前：${describeRoute(activeRoute)}`,
    '',
    '点下面的按钮切换。',
  ].join('\n');
}

runtime.on('down', (reason) => {
  console.error(`[dsh] runtime down: ${reason}`);
});
runtime.on('restarted', () => {
  console.log('[dsh] runtime back up');
});
runtime.on('error', (err) => {
  console.error(`[dsh] ${err.message}`);
});
runtime.on('tooManyFailures', async (info) => {
  console.error(`[dsh] 连续重启失败 ${info.consecutiveFailures} 次，当前 provider=${info.currentProvider}，尝试切换到 ds`);
  const fallback = routeByKey('ds');
  if (fallback) {
    try {
      await activateRoute(fallback, { rotateSessions: false, persist: false });
      console.log(`[model] 通过 tooManyFailures 事件自动回退到「${fallback.short}」`);
    } catch (err) {
      console.error(`[model] tooManyFailures 回退也失败: ${err.message}`);
    }
  }
});

/**
 * Move to another route after the active one rejected a turn. Like the boot
 * fallback, an automatic switch is deliberately NOT persisted, so a default
 * that later recovers is picked up again on the next restart.
 *
 * @returns {Promise<object|null>} the route now in use, or null when none works
 */
async function failOverRoute(detail) {
  const from = activeRoute;
  for (const route of fallbackChainAfter(from.key)) {
    try {
      await activateRoute(route, { persist: false });
      console.error(`[model] ${from.key} 调用失败,自动切到 ${route.key}:${truncate(detail, 160)}`);
      return route;
    } catch (err) {
      console.error(`[model] 自动回退到 ${route.key} 也失败:${err.message}`);
    }
  }
  return null;
}

/**
 * Queue one user turn on a chat's session and stream progress into Telegram.
 *
 * The SDK runtime can only *create* sessions: `session/prompt` on an id that
 * already exists on disk is rejected with "already exists". So a DSH (or bot)
 * restart invalidates every stored id. Rather than failing the user's message,
 * rotate to a fresh session and say so.
 *
 * A turn the provider rejects surfaces as a `turn/end` event whose
 * `reason.kind` is `'error'` — `session/prompt` only reports that the turn was
 * queued — so route failover hangs off the event, and a failed turn is reported
 * as a failure instead of an empty "✅ 已完成".
 *
 * @returns {Promise<void>}
 */
async function runPrompt(chatId, contentBlocks) {
  const status = new LiveStatus(telegram, chatId);
  await status.begin();

  const turn = { sessionId: sessionFor(chatId).sessionId };
  saveState();

  // Mark the turn as running so a crash mid-turn is visible on the next boot.
  // ⚠️ This only REPORTS a possible loss — it does not prevent one. The cursor
  // is still persisted at dispatch time (see pollLoop), because waiting for the
  // turn to finish before confirming the offset would make getUpdates replay the
  // same batch for the whole turn (the 2026-09-12 infinite-replay bug).
  markTurnInFlight(chatId);

  let assistantText = '';
  let turnEndReason = null;
  let waiter = null;
  let failedOver = false;

  const onSessionEvent = ({ sessionId, event }) => {
    if (sessionId !== turn.sessionId) return;
    if (event.type === 'turn/end') {
      turnEndReason = event.data?.reason ?? null;
      return;
    }
    if (event.type === 'tool/call') {
      status.addNote(describeTool(event.data.name, event.data.arguments));
      return;
    }
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) return;
      const text = content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text ?? block.reasoning ?? '')
        .join('');
      if (text.trim()) {
        assistantText = text;
        status.trackProgress(text.length);  // 吐字速度采样（render() 里显示 ≈N 字/秒）
        status.addNote(text);  // 让 agent 的文字实时显示在"正在处理…"里（含确认信息）
      }
    }
  };

  const startTurn = async () => {
    turnEndReason = null;
    // 一轮 = 「用户提问 → 我给出最终回答」。采样必须在这里清零，否则
    // firstCharAt/lastCharCount 会跨轮残留：上一轮的字数被算进这一轮，
    // 或者这一轮的时间戳停在旧值 → 尾巴时有时无。
    // resetSampler() 同时把 turnStartedAt 设为此刻，作为 elapsed 的兜底计时。
    status.resetSampler();
    waiter?.cancel();
    waiter = runtime.createTurnWaiter(turn.sessionId);
    // ⭐ 冷启动记忆注入：仅本会话第一条 prompt 会拿到非空前言（见 takeBootstrapPrefix）。
    //    拼在**第一个 text block 前面**，图片等其它 block 顺序不变。
    const boot = takeBootstrapPrefix(chatId);
    const blocks = boot ? prependTextBlock(contentBlocks, boot) : contentBlocks;
    await runtime.prompt(turn.sessionId, blocks);
  };

  const rotateSession = async (notice) => {
    waiter?.cancel();
    assistantText = '';
    turn.sessionId = resetSession(chatId).sessionId;
    if (notice) await telegram.sendMessage(chatId, notice);
  };

  runtime.on('session-event', onSessionEvent);
  try {
    for (;;) {
      try {
        await startTurn();
      } catch (err) {
        if (!/already exists/i.test(err.message)) throw err;
        await rotateSession(
          '♻️ 上一轮的会话已经失效(DSH 或 bot 重启过),已自动开启新会话。',
        );
        await startTurn();
      }

      const finished = await waiter.done;
      if (!finished) {
        await status.fail('等待回复超时(30 分钟)。');
        return;
      }

      if (turnEndReason?.kind === 'error') {
        const failure = turnEndReason.error ?? {};
        const detail = failure.message ?? failure.error?.message ?? '模型调用失败';
        const broken = activeRoute;
        if (!failedOver && isRouteFailure(failure)) {
          const next = await failOverRoute(detail);
          if (next) {
            failedOver = true;
            await rotateSession(
              `🔁 模型「${broken.label}」不可用,已自动切换到「${next.label}」并重试。\n原因:${truncate(detail, 200)}`,
            );
            continue;
          }
        }
        await status.fail(detail);
        return;
      }
      break;
    }

    const answer = prefixReply(assistantText);
    // 流水账:记下助手回复(TG 侧)。放在 finish 前,确保即使发送被限流也留下账。
    ledgerRecord('assistant', answer, chatId);
    // ① TG 自己交付：编辑进度占位消息 + markdown→HTML + 标签感知切分 + 限流回退。
    //    这套是 TG 端点独有的能力（微信没有进度消息），端点适配器的 send() 做不到，
    //    所以 TG 的最终答案必须由 LiveStatus 交付。
    await status.finish(answer);
    // ② 再让节点同步给**其他**端点（微信等）。
    //    ⛔ 2026-09-19 修：这里原先不带 exclude，而 hub 出站是"不排除任何端点"的
    //    （hub.js:156），TG 端点自己也在广播目标里 → 同一条回答发给 TG **两次**
    //    （用户实测「重复回答」）。微信侧 bot.js:1858 已经是不重复的，这里漏了。
    //    ⛔ 不要为了"对称"删掉上面的 status.finish() 改成纯广播：那会让 TG 退化成
    //    「进度消息残留 + 裸文本答案」（endpoints/tg.js#send 只做裸 sendMessage）。
    await hubBroadcast(answer, 'TG 回答', { exclude: 'tg' });
  } catch (err) {
    waiter?.cancel();
    await status.fail(err.message);
  } finally {
    runtime.off('session-event', onSessionEvent);
    // Cleared on every exit path (success, fail, timeout, throw) so a stale
    // marker cannot produce a false warning on the next boot.
    clearTurnInFlight(chatId);
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;

  // 防循环:微信镜像进 TG 的消息用于"让你另一处也看到",不应再当真人消息
  // 处理,也不应镜回微信(否则 A→B→A 无限循环)。
  const rawTextPre = (message.text ?? message.caption ?? '').trim();
  if (rawTextPre.startsWith(WX_MIRROR_TAG)) return;

  // ---- 群模式（2026-10-06 用户定）----
  // 群里只应点名：@我 才接活，没人点名不抢话；陌生人的消息静默忽略
  // （⛔ 不把「已绑定别的用户」这种私聊提示发进群里刷屏）；/指令仍留在私聊。
  const isGroupChat = message.chat?.type === 'group' || message.chat?.type === 'supergroup';
  let groupText = null;
  if (isGroupChat) {
    if (state.ownerUserId !== userId) return; // 陌生人：静默
    const raw = (message.text ?? message.caption ?? '').trim();
    const mention = `@${botInfo?.username ?? ''}`;
    if (!botInfo?.username || !raw.includes(mention)) return; // 没点名 → 不接
    groupText = raw.split(mention).join('').trim();
    if (groupText.startsWith('/')) return; // 指令不进群，回私聊用
  }

  const decision = authorize(userId);
  if (!decision.ok) {
    const why =
      decision.reason === 'not-owner'
        ? `这个 bot 已经绑定了别的用户。你的 Telegram 用户 ID 是 ${userId}。`
        : `你没有权限使用这个 bot。你的 Telegram 用户 ID 是 ${userId}。`;
    await telegram.sendMessage(chatId, why);
    return;
  }

  const rawText = isGroupChat ? groupText : (message.text ?? message.caption ?? '').trim();

  if (rawText.startsWith('/')) {
    const [command] = rawText.split(/\s+/);
    const handled = await handleCommand(chatId, userId, command.toLowerCase().split('@')[0]);
    if (handled) return;
  }

  const blocks = [];
  if (rawText) blocks.push({ type: 'text', text: rawText });

  // ---------------------------------------------------------------------------
  // Image: download → base64 → `image` content block
  //
  // SDK 约定（@deepseek-ai/dsh-sdk-jsonrpc-server 的 encodedImage 判据）：
  //   { type: 'image', data: <canonical base64>, mimeType: 'image/png' }
  // 由 durablePromptContent() 转成附件引用再交给模型。
  // ⚠️ 此前只声明了模型 inputModalities，却**从没把图片块压进 blocks** ——
  //    所以无论配置怎么改，图片都被静默丢掉，模型只收到文字。
  // ---------------------------------------------------------------------------

  const photo = message.photo?.[message.photo.length - 1];
  const imageDocument =
    message.document && String(message.document.mime_type ?? '').startsWith('image/')
      ? message.document
      : null;
  const imageFileId = photo?.file_id ?? imageDocument?.file_id ?? null;

  if (imageFileId) {
    try {
      const bytes = await telegram.getFileBytes(imageFileId);
      console.log(`[tg] image downloaded: ${bytes.length} bytes, mimeType=${imageDocument?.mime_type ?? 'image/jpeg'}`);
      blocks.push({
        type: 'image',
        data: bytes.toString('base64'),
        mimeType: imageDocument?.mime_type ?? 'image/jpeg',
      });
    } catch (err) {
      console.error(`[tg] image download failed: ${err.message}`);
      await telegram.sendMessage(chatId, `❌ 图片下载失败:${err.message}`);
      return;
    }
  } else {
    console.log(`[tg] no image in message: photo=${!!message.photo}, document=${!!message.document}, file_id=${imageFileId}`);
  }

  // ---------------------------------------------------------------------------
  // Voice: download OGG → ffmpeg → WAV → whisper → text
  // ---------------------------------------------------------------------------

  const voice = message.voice;
  if (voice) {
    try {
      const audioBytes = await telegram.getFileBytes(voice.file_id);
      const tmpWav = `/tmp/dsh-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`;
      writeFileSync(tmpWav, audioBytes);

      // ffmpeg: OGG → 16 kHz mono PCM WAV (Whisper standard input)
      const wavOut = `${tmpWav}.whisper.wav`;
      execFileSync('ffmpeg', [
        '-i', tmpWav,
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        '-y', wavOut,
      ], { timeout: 30000 });

      // transcription (backend 由 .env 的 ASR_BACKEND 决定：whisper | sensevoice)
      // ASR_KEEPALIVE=1 时走常驻服务（~0.4s），否则冷启动（~7s）
      const result = await asrTranscribe(wavOut);

      // cleanup temp files
      try { unlinkSync(tmpWav); } catch {}
      try { unlinkSync(wavOut); } catch {}

      if (result) {
        console.log(`[tg] voice transcription for ${userId}: ${result}`);
        blocks.push({ type: 'text', text: result });
        // 语音回显（2026-10-06 用户定）：把听到的文字原样发回，让你核对转写对不对。
        // 纯 sendMessage（不走富文本）：转写内容是原话，可能含 markdown/HTML 特殊字符。
        await telegram
          .sendMessage(chatId, `🎤 ${result}`)
          .catch((err) => console.error(`[tg] 语音回显发送失败: ${err.message}`));
      } else {
        await telegram.sendMessage(chatId, '⚠️ 语音转文字结果为空，请确认语音内容是否清晰。');
        return;
      }
    } catch (err) {
      console.error(`[tg] voice transcribe failed: ${err.message}`);
      await telegram.sendMessage(chatId, `❌ 语音转文字失败:${err.message}`);
      return;
    }
  }

  if (blocks.length === 0) {
    await telegram.sendMessage(
      chatId,
      '我目前只能处理文字、图片和语音。文件等内容还不支持。',
    );
    return;
  }

  if (decision.claimed) {
    await telegram.sendMessage(
      chatId,
      `🔐 你已成为这个 bot 的主人(用户 ID ${userId}),以后只有你能使用它。`,
    );
  }

  // TG→微信镜像:主人明确给 bot 发的内容,同步推送到微信入口(同一会话)。
  // 端点 → 节点：这条同步给其他所有端点（微信等）。
  // ⚠️ 只广播给「其他端点」，不回显给自己（否则 TG 会收到自己刚说的话）。
  // 这正是「端点 → 节点 → 其他所有端点」那一半。
  if (weixin.enabled && decision.ok) {
    const mirrorText = rawText || (blocks.length > 0 ? blocks.map(b => b.text).join(' ') : '');
    if (mirrorText) {
      hub.broadcast(
        makeMessage({ source: 'tg', chatId, text: mirrorText }),
        { exclude: 'tg', label: 'TG 入站' },
      ).catch((err) => console.error(`[${_ts()}][hub] TG 入站广播失败: ${err.message}`));
    }
  }

  // 流水账:记下用户原话(TG 侧)。语音场景 rawText 为空 → 用 blocks 里的转写文本。
  {
    const userText = rawText || (blocks.length > 0 ? blocks.map(b => b.text).join(' ') : '');
    if (userText) ledgerRecord('user', userText, chatId);
  }

  submitTurn(chatId, blocks); // 忙时合包：空闲立刻跑，忙碌攒着合并跑（见 chatMailboxes 注释）

  // Debug: log blocks content for image troubleshooting
  const hasImage = blocks.some(b => b.type === 'image');
  if (hasImage) {
    console.log(`[tg] DEBUG blocks sent to SDK: ${JSON.stringify(blocks.map(b => b.type === 'image' ? {type:b.type,dataLen:b.data?.length,mimeType:b.mimeType} : b))}`);
  }
}

async function handleCommand(chatId, userId, command) {
  switch (command) {
    case '/start':
    case '/help':
      await telegram.sendMessage(
        chatId,
        [
          '👋 我是接在 DeepSeek Harness 上的助手,直接发消息就能用。',
          '',
          '可用命令:',
          '/new — 开启一个全新会话(清空上下文)',
          '/model — 切换模型(' + ROUTES.map(r => r.label).join(' / ') + ')',
          '/restart — 重启 bot 加载新代码（会断开当前会话）',
          '/setupdsh — 升级 DSH&BOT（Git / Node / DSH / 插件）',
          '/status — 查看当前会话和运行状态',
          '/whoami — 查看你的 Telegram 用户 ID',
          '/help — 显示这份帮助',
          '',
          '也可以直接发图片、语音给我。',
        ].join('\n'),
      );
      return true;

    case '/new': {
      // ⚠️ 必须在 resetSession() **之前**写 handoff —— 它要读旧会话的
      // createdAt 来数「本次会话聊了几条」；重置后就数不到了。
      // 不足 20 条（频繁调试）→ 跳过，不覆盖已有记忆。
      maybeWriteHandoff({ chatId, reason: 'new' });
      const record = resetSession(chatId);
      await telegram.sendMessage(chatId, `🆕 已开启新会话。\n会话 ID: ${record.sessionId}`);
      return true;
    }

    case '/model': {
      await telegram.sendMessage(chatId, modelMenuText(), { reply_markup: modelKeyboard() });
      return true;
    }

    case '/status': {
      const record = sessionFor(chatId);
      const ageMinutes = Math.round((Date.now() - record.createdAt) / 60000);
      await telegram.sendMessage(
        chatId,
        [
          '📊 当前状态',
          `会话 ID: ${record.sessionId}`,
          `已存在: ${ageMinutes} 分钟`,
          `工作目录: ${config.workspace}`,
          `模型: ${activeRoute.key} — ${activeRoute.provider} / ${activeRoute.model}` +
            (() => {
              const effort = reasoningEffortFor(activeRoute, config.reasoningEffort);
              if (effort === 'off') return ' (思考已关闭)';
              return effort ? ` (思考强度 ${effort})` : '';
            })(),
          `权限模式: 由 ~/.dsh/settings.yaml 的 permission.defaultPreset 决定（bot 不覆盖）`,
          `DSH 进程: ${runtime.ready ? '运行中 ✅' : '未运行 ⚠️'}`,
        ].join('\n'),
      );
      return true;
    }

    case '/whoami':
      await telegram.sendMessage(
        chatId,
        `你的用户 ID: ${userId}\n本聊天 ID: ${chatId}`,
      );
      return true;

    case '/restart':
      // 重启当前 bot,加载新代码。
      try {
        await handleRestartCommand(chatId, (t) => telegram.sendMessage(chatId, t));
      } catch (err) {
        console.error(`[tg] /restart failed: ${err.stack ?? err.message}`);
        await telegram
          .sendMessage(
            chatId,
            `❌ 重启指令执行失败:${err.message}\n\n请从终端/Web GUI 手动 ./bot.sh restart。`,
          )
          .catch(() => {});
      }
      return true;

    case '/setupdsh':
      // 升级 DSH&BOT(Git / Node / DSH 本体 / 插件)。后台 detached 跑,本回合立刻返回。
      try {
        await handleSetupdshCommand(chatId);
      } catch (err) {
        console.error(`[tg] /setupdsh failed: ${err.stack ?? err.message}`);
        await telegram
          .sendMessage(
            chatId,
            `❌ 升级指令执行失败:${err.message}\n\n请从终端手动跑:setupdsh`,
          )
          .catch(() => {});
      }
      return true;

    default:
      return false;
  }
}

/**
 * `/restart` — 重启 bot 以便加载新代码,无需物理接触电脑。
 *
 * ⚠️ 为什么不能在 bot 自己的进程里直接跑 ./tg.sh restart:
 * 那是自杀 —— stop 杀掉 bot → 承载本 agent 会话的 DSH runtime 随之退出,
 * 当前回合被 dispose,回复永远发不出(2026-09-12 事故)。
 * 正确做法:把「延迟重启」交给一个** detached 的独立子进程**(restart-helper.sh):
 *   - spawn(detached:true) 在 POSIX 上对子进程调 setsid(),使之成为独立进程组/会话,
 *     因而 **launchctl kill** 的广播(只覆盖 launchd job 自己的进程组)打不到它;
 *   - 它不匹配 tg.sh 的 BOT_PATTERN(`^node .*bot\.js$`),tg.sh stop 也不会误杀它。
 * 这样 bot 干净退出、重启在 bot 之外完成,当前回合也在 helper 的 sleep 窗口里走完。
 *
 * 顺序:①写交接 handoff(新会话靠它接续记忆)→ ②发确认消息给用户 →
 * ③ spawn detached helper（sleep → 停 BOT 自己 → 重启 BOT）。
 */
async function handleRestartCommand(chatId, reply) {
  // ⚠️ BOT 是 TG 的独立副本，helper 就在**本目录**，不在 config.workspace/TG。
  // 原写法 join(config.workspace, 'TG', ...) 会去跑 TG 的 helper → 动到 TG（禁止）。
  const helper = new URL('restart-helper.sh', import.meta.url).pathname;

  // ① 写交接:把「改动完成、待重启生效」固化到 memory/handoff/,新会话会读它。
  // ⚠️ /restart 是**显式**指令，用户就是要留档 → 无条件写，不走"不足 20 条就跳过"。
  const handoffPath = writeHandoff({ chatId, reason: 'restart' });

  // ② 确认消息。helper 会 sleep 一段时间让这条消息发出、本回合走完再动 bot。
  // ⚠️ 回执走调用方给的 reply（TG→telegram，微信→weixin）：写死 telegram.sendMessage
  //    时，微信侧会用微信用户 id 当 TG chat_id → chat not found（2026-10-02 实测）。
  const delaySec = Number(process.env.RESTART_DELAY_SECONDS ?? 8);
  await reply(
    [
      `♻️ 已收到重启指令。`,
      ``,
      `已写入交接记录:\n${handoffPath ?? '(交接写入失败,但仍将重启)'}`,
      `将在约 ${delaySec} 秒后重启 bot,以加载新的格式化代码。`,
      ``,
      `⚠️ 重启会断开当前会话(DSH 无法续接,只能重建)。`,
      `重启完成后,请发任意一条消息唤醒我 —— 新会话会先读 handoff 接上刚才的记忆。`,
    ].join('\n'),
  ).catch(() => {});

  // ③ 拉起 detached 重启脚本。脚本自己 sleep → 停本进程 → 重启 BOT，独立于本进程。
  const child = spawn('/bin/bash', [helper], {
    detached: true,          // setsid() → 独立进程组/会话,不被 job 广播命中
    stdio: 'ignore',
    cwd: APP_DIR,  // ✅ BOT 自己的目录（动态解析，搬家后不必再改）；不用 config.workspace（那是 DSH/，会指到 TG 去）
    env: {
      ...process.env,
      RESTART_DELAY_SECONDS: String(delaySec),
      // ⚠️ 2026-10-01 修「/restart 点了等于没点」:
      //    本目录的 restart-helper.sh 已换成**插件版**（读 RESTART_TARGET_PID / RESTART_LAUNCHER 等），
      //    而这里原先只传 RESTART_DELAY_SECONDS → helper 每次都是
      //    「❌ 没给目标 pid，放弃重启」立刻退出（见 dsh-restart.log 16:27 起共 6 次）。
      //    补齐插件同款变量，软件版才真的会重启。
      RESTART_TARGET_PID: String(process.pid),
      RESTART_LOG: join(APP_DIR, 'dsh-restart.log'),
      ...(existsSync(join(APP_DIR, '启动.command'))
        ? { RESTART_LAUNCHER: join(APP_DIR, '启动.command') }
        : {
            RESTART_NODE: process.execPath,
            RESTART_SCRIPT: process.argv[1],
            RESTART_CWD: APP_DIR,
          }),
      // 等旧进程真正释放 token（否则新实例 getUpdates 吃 409 自杀）
      ...(process.env.TELEGRAM_BOT_TOKEN ? { RESTART_TG_TOKEN: process.env.TELEGRAM_BOT_TOKEN } : {}),
    },
  });
  child.unref(); // 不保留对它的引用,避免只因为我们在跑就拖住它
  console.log(`[tg] /restart: detached restart helper spawned (${helper})`);
}

/**
 * `/setupdsh` 的「真动作」:把升级脚本拉起来（detached）。
 *
 * 与 /restart 同款思路:升级要跑 1~2 分钟,⛔ 不能在 bot 进程里等(会卡住对话)——
 * 交给 detached 的 setupdsh-helper.sh(就在**本目录**,与 setupdsh.sh 同级)后台跑。
 * 升完新代码要重启一次才生效 → 再点一次 /restart。
 *
 * ⚠️ 与回执**拆开**：回执只能走调用方自己的通道（TG→telegram，微信→weixin），
 *    写死 TG 会让微信端「先回话」那步就炸，脚本永远拉不起来（2026-10-02 实测）。
 * @returns {boolean} 是否拉起来了
 */
function spawnSetupdshHelper() {
  const helper = new URL('setupdsh-helper.sh', import.meta.url).pathname;
  if (!existsSync(helper)) return false;
  const child = spawn('/bin/bash', [helper], {
    detached: true,
    stdio: 'ignore',
    cwd: APP_DIR,  // ✅ BOT 自己的目录(动态解析,搬家后不必再改)
    env: { ...process.env },
  });
  child.on('error', (err) => console.error(`[setupdsh] helper spawn failed: ${err.message}`));
  child.unref();
  console.log(`[setupdsh] detached setupdsh helper spawned (${helper})`);
  return true;
}

/**
 * `/setupdsh` 的 TG 侧入口：拉脚本 + 用 TG 通道回执。
 * 微信端**不要**走这里 —— 它用的是微信会话 id，发给 TG 必报 chat not found。
 */
async function handleSetupdshCommand(chatId) {
  await telegram.sendMessage(
    chatId,
    [
      '⬆️ 已收到升级指令,正在后台升级 DSH&BOT。',
      '',
      '升级范围:Git / Node / DSH 本体 / 已装机器人的插件,约 1~2 分钟。',
      '升完后再点一次 /restart,新版本才生效。',
    ].join('\n'),
  );
  if (!spawnSetupdshHelper()) {
    await telegram.sendMessage(chatId, '⚠️ 没找到 setupdsh-helper.sh,没法升级。').catch(() => {});
  }
}

/**
 * 判定一条 👤 用户原文是否「无信息量」（语气词/寒暄/重复）。
 * 复用摘要链路的 classifyUserText()，保证口径一致。
 * @param {string} body 用户原文
 * @param {Set<string>} seen 去重集合（筛掉的条目不入集合）
 */
function isFillerEntry(body, seen) {
  try {
    return classifyUserText(body, seen).action === 'drop';
  } catch {
    return false; // 判不了就保留，宁可多留不可误杀
  }
}

/**
 * 读流水账，从**最末尾往回倒数 20 条**对话原文（👤 用户 + 🤖 助手 都留）。
 *
 * 用户 2026-09-16 定死（原话）：「重启前的文件是聊天记录最新开始倒数取 20 条」。
 * 即：起点 = 流水账最新那条（不管是谁发的），往回数满 40 个条目就停。
 *
 * ⚠️ 别自作聪明加条件（我 2026-09-16 连错两版，记在这里防复发）：
 *   - ❌ 不要按「轮」配对成 20 轮 —— 就是字面的 40 个条目
 *   - ❌ 不要按摘要生成时间切边界 —— 摘要不参与这个切分
 * 就一句：`entries.slice(-40)`。
 *
 * @param {string|null} ledgerRaw 流水账**正文**（由 readLedgerText() 读好传入；
 *   2026-09-17 起账本按月分文件，不再传路径，避免这里再拼一次文件名）
 * @param {number} maxEntries 取末尾多少条（默认 20）
 * @returns {string} 可直接嵌入 markdown 的正文；读不到时返回提示串
 */
function readRecentLedgerEntries(ledgerRaw, maxEntries = 20) {
  try {
    if (ledgerRaw === null || ledgerRaw === undefined) return '（流水账文件不存在，无法提取）';
    const raw = String(ledgerRaw);

    // 条目分隔：`## 2026-09-16 04:40:40  👤 用户` / `  🤖 助手`
    const parts = raw.split(/^## /m).slice(1); // 丢掉文件头
    /** @type {{ts:string, icon:string, who:string, body:string}[]} */
    const entries = [];
    for (const p of parts) {
      const nl = p.indexOf('\n');
      if (nl < 0) continue;
      const head = p.slice(0, nl).trim();          // 2026-09-16 04:40:40  👤 用户
      const body = p.slice(nl + 1).trim();
      const m = head.match(/^(\S+ \S+)\s+(👤|🤖)\s*(\S*)/);
      if (!m) continue;
      entries.push({ ts: m[1], icon: m[2], who: m[3] || (m[2] === '👤' ? '用户' : '助手'), body });
    }
    if (entries.length === 0) return '（流水账里没有可提取的对话条目）';

    // ⭐ 用户 2026-09-16 改定：取「**有用的**末尾 20 条」，不是机械数 20 条。
    // 旧版 `entries.slice(-maxEntries)` 会把「嗯」「好」「对」这类语气词也算进名额，
    // 20 条里常有一半是废话。现改为：先用语气词表筛掉无信息量的 👤，
    // 其所属那轮的 🤖 回复一并丢弃（整轮无信息量），再取末尾 20 条。
    // 复用摘要链路的 classifyUserText()（summarizer.mjs），口径与摘要一致。
    //
    // 实现：按时序把条目切成「轮」——每遇到一条 👤 就开新轮，
    // 其后的 🤖 归属该轮。轮内 👤 无信息量 → 整轮丢弃；否则整轮保留。
    // ⚠️ 不截断 🤖 正文（我的回复里的结论不能砍）。
    const seen = new Set();
    const turns = [];
    for (const e of entries) {
      if (e.icon === '👤') {
        turns.push({ keep: !isFillerEntry(e.body, seen), items: [e] });
      } else {
        // 没有前置 👤 的孤儿助手消息，挂到当前轮；都没有就自己开一轮
        if (turns.length === 0) turns.push({ keep: true, items: [] });
        turns[turns.length - 1].items.push(e);
      }
    }
    const kept = turns.filter((t) => t.keep).flatMap((t) => t.items);
    const picked = (kept.length ? kept : entries).slice(-maxEntries);

    const out = picked.map((e) => {
      // 正文可能是多行（我以前的回答里有缩进代码块），统一压成引用块
      const quoted = e.body
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n');
      return `### ${e.icon} ${e.who} · ${e.ts}\n${quoted}`;
    }).join('\n\n');

    const userCount = picked.filter((e) => e.icon === '👤').length;
    const asstCount = picked.filter((e) => e.icon === '🤖').length;
    return `（共 ${picked.length} 条：👤 用户 ${userCount} / 🤖 助手 ${asstCount}）\n\n${out}`;
  } catch (err) {
    return `（读取流水账失败：${err.message}）`;
  }
}

/** handoff 触发原因的人话描述（写进正文，让新会话知道"上次是怎么断的"）。 */
const REASON_TEXT = {
  restart: {
    by: '/restart 指令',
    why: '在 Telegram 里执行了 **/restart**，目的是让 bot 加载新代码。',
  },
  new: {
    by: '/new 指令',
    why: '在 Telegram 里执行了 **/new**（开启全新会话、清空上下文），断开前留下本次进展。',
  },
  model: {
    by: '模型切换',
    why: '用户切换了模型。DSH 的模型在一个进程内固定，换模型 = 重启子进程 + 清空会话上下文。',
  },
  boot: {
    by: '启动补写',
    why: 'bot 进程重启（launchd 拉起 / 崩溃自愈 / 开机）。⚠️ 这类断开**来不及**在断开前写，'
      + '本文件是启动时**事后补写**的：内容取自流水账，正确；但时间戳是启动时刻，晚于真实断开时刻。',
  },
};

/** 会话内不足这么多条 = 在频繁调试，不覆盖 handoff（用户 2026-09-16 定）。 */
const HANDOFF_MIN_TURNS = 20;

/**
 * 数「某时刻之后」流水账里有多少条 —— 用来判断本次会话是不是只聊了几句。
 *
 * ⚠️ 为什么不能直接数流水账总条数（我 2026-09-16 差点这么写）：
 * 流水账是**永久累积**的（只增不删，跨几十个会话），`/new` 不清它。
 * 所以「总条数 ≥ 20」永远为真，等于没判断。必须按时间戳过滤。
 *
 * @param {string} ledgerFile 流水账绝对路径
 * @param {number} sinceMs 起始毫秒时间戳（会话 createdAt）
 * @returns {number} 该时刻之后的条目数；读不到返回 0
 */
function countLedgerEntriesSince(ledgerRaw, sinceMs) {
  try {
    if (ledgerRaw === null || ledgerRaw === undefined) return 0;
    const raw = String(ledgerRaw);
    const parts = raw.split(/^## /m).slice(1);
    let n = 0;
    for (const p of parts) {
      const nl = p.indexOf('\n');
      if (nl < 0) continue;
      const head = p.slice(0, nl).trim();
      const m = head.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
      if (!m) continue;
      // 流水账时间戳是本地时间（见 ledger 写入格式），按本地解析。
      const t = new Date(`${m[1]}T${m[2]}`).getTime();
      if (Number.isFinite(t) && t >= sinceMs) n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * 生成并返回 handoff 文件路径;失败返回 null(调用方降级)。
 *
 * ⚠️ 用户 2026-09-16 改定：**不只是 /restart 写 handoff**。
 * 任何「会话会断」的时机都要写，否则新会话接上的是旧记忆：
 *   - `/restart`        断开前写（reason='restart'）
 *   - `/new`            断开前写（reason='new'，条数不足则跳过）
 *   - 切模型            断开前写（reason='model'，条数不足则跳过）
 *   - 启动补写          断开后补（reason='boot'，仅当确有新内容时）
 *
 * @param {object} opts
 * @param {number|string} opts.chatId 归属会话
 * @param {string} [opts.reason] 触发原因：restart | new | model | boot
 */
function writeHandoff({ chatId, reason = 'restart' }) {
  try {
    const handoffDir = join(MEMORY_DIR, 'handoff');
    mkdirSync(handoffDir, { recursive: true });

    const now = new Date();
    // ⚠️ 固定文件名，**永远覆盖，不新增**（用户 2026-09-16 定死）。
    // 曾用 `${stamp}-restart.md`（时间戳命名）→ 每次重启新建一个，
    // 时间戳永不重复 ⇒ 只堆积不覆盖，堆了 59 份历史垃圾，且 get-context
    // 要靠 sort() 猜"最近一份"。与摘要（summaries/summary.md 单份覆盖）对齐：
    // 重启前记录也只保留**一份**，重启时被最新的覆盖。
    // 生成时间写在正文标题里（见下方 `# Handoff · ...（ISO 时间）`），不再靠文件名。
    const file = join(handoffDir, 'handoff.md');

    const sessionId = sessionFor(chatId).sessionId;
    const record = state.chats?.[String(chatId)];

    // ⚠️ 用户 2026-09-16 定死：handoff **不是**模板，是「摘要之后 → 重启之前」
    // 这一段的实录。摘要由定时链路管（重启不碰摘要），handoff 专补摘要的盲区。
    // 旧代码这里写死了 3 条 9/15 的常量 → 每次重启都写同一份旧事，
    // 新会话接不上真正进度（这就是"重启后忘光"的根因）。现改为读流水账。
    // 按月账本：正文整份取出（本月没有则回看历史月），再从中取末尾 20 条
    const ledgerText = readLedgerText();
    const recent = readRecentLedgerEntries(ledgerText, 20); // 末尾往回 20 条
    const ledgerRel = `memory/conversation-cache/raw/ledger/${ledgerMonthFile()}`;

    // 摘要覆盖到哪（只读，用于说明"下面这段是摘要之后的"）
    // ⛔ 2026-09-16 删除：摘要已退役（不再生成、不再注入），这行只会写出一个
    //    永远停在退役那天的陈旧时间戳，是自相矛盾的死信息。别再读 summary.md。

    const lines = [
      `# Handoff · 重启前记录（${now.toISOString()}）`,
      ``,
      `> 由 ${REASON_TEXT[reason]?.by ?? '系统'} 自动生成。用途:会话断了之后续不上(SDK 硬限制),`,
      `> 新会话先读本文件接续记忆。会话 id: \`${sessionId}\`(chat ${chatId})。`,
      ``,
      `## 本文件记的是什么`,
      ``,
      `| 项 | 值 |`,
      `|---|---|`,
      `| 取法 | 流水账**最新一条**开始，往回**倒数 20 条**（👤/🤖 都留，不配对） |`,
      `| 流水账全集 | \`${ledgerRel}\`（按月分文件，旧月份为同目录下的 YYYY-MM.md） |`,
      ``,
      `## 本次触发的原因`,
      REASON_TEXT[reason]?.why ?? `会话断开（${reason}）。`,
      ``,
      `## 上次进展（聊天记录最新开始，往回倒数 20 条原文；👤 用户 / 🤖 助手 都留）`,
      ``,
      recent,
      ``,
      `## 快照(证据)`,
      `| 项 | 值 |`,
      `|---|---|`,
      `| 触发时间 | ${now.toISOString()} |`,
      `| 触发会话 | ${sessionId} |`,
      `| 归属 owner | ${state.ownerUserId ?? '?'} |`,
      `| 当前模型 | ${activeRoute.key} (${activeRoute.provider}/${activeRoute.model}) |`,
      `| 工作目录 | ${config.workspace} |`,
      ``,
      `## 重启后最简单试法`,
      `直接给 bot 发一句正常消息 → 恢复回应,即说明重启成功。`,
      `然后发一条带 \`**\` 的长消息验证富文本。`,
      ``,
    ].join('\n');

    // ⚠️ 必须**直接覆盖**，不能用 `{ flag: 'wx' }`（用户 2026-09-16 定死）。
    // 旧代码文件名是 `${stamp}-restart.md`（时间戳永不重复），`wx` 当时是对的；
    // 改成固定名 `handoff.md` 后还留着 `wx`，语义就反转成「只写第一次，之后永远
    // EEXIST 拒绝」—— 2026-09-16 04:34 那次 /restart 就是这样静默失败的（见 bot.log:2923）。
    writeFileSync(file, lines); // 固定单份，每次直接覆盖
    console.log(`[tg] handoff(${reason}): written to ${file}`);
    return file;
  } catch (err) {
    console.error(`[tg] handoff(${reason}) write failed: ${err.message}`);
    return null;
  }
}

/**
 * 断开「之前」写 handoff，但**只在本次会话真的聊过东西时才写**。
 *
 * ⚠️ 用户 2026-09-16 定死的判据：会话内**不足 20 条**说明是在频繁调试
 * （刚开就 /new、反复切模型），**不要覆盖**已有的好记忆。
 * 判据必须是「本次会话 createdAt 之后」的条数 —— 流水账总数永远 ≥ 20，数它没意义。
 *
 * @returns {'written'|'skipped'|'failed'} 实际结果（便于回话里如实交代）
 */
function maybeWriteHandoff({ chatId, reason }) {
  try {
    const record = sessionFor(chatId);
    const n = countLedgerEntriesSince(readLedgerText(), record.createdAt);
    if (n < HANDOFF_MIN_TURNS) {
      console.log(`[tg] handoff(${reason}): skipped — 本次会话仅 ${n} 条(<${HANDOFF_MIN_TURNS}，视为调试)`);
      return 'skipped';
    }
    return writeHandoff({ chatId, reason }) ? 'written' : 'failed';
  } catch (err) {
    console.error(`[tg] handoff(${reason}) skipped on error: ${err.message}`);
    return 'failed';
  }
}

/**
 * Handle the inline keyboard behind /model. Telegram requires every button
 * press to be acknowledged, even when the switch itself then fails.
 */
async function handleCallbackQuery(query) {
  const chatId = query.message?.chat?.id;
  const userId = query.from?.id;
  const data = String(query.data ?? '');

  try {
    await telegram.answerCallbackQuery(query.id);
  } catch (err) {
    console.error(`[tg] answerCallbackQuery failed: ${err.message}`);
  }

  if (!chatId) return;

  const decision = authorize(userId);
  if (!decision.ok) {
    await telegram.sendMessage(chatId, '你没有权限使用这个 bot。');
    return;
  }

  if (data === 'restart') {
    // 「重启」入口:命令列表里的 restart 命令(以及历史遗留的旧选单按钮)走这里,
    // 与 /restart 命令走同一条远程重启路径。
    // ⚠️ 它会 spawn detached 独立进程执行 stop→start,不自杀;本回调先走完再重启。
    try {
      await handleRestartCommand(chatId, (t) => telegram.sendMessage(chatId, t));
    } catch (err) {
      console.error(`[tg] restart (from menu) failed: ${err.stack ?? err.message}`);
      await telegram
        .sendMessage(chatId, `❌ 重启指令执行失败:${err.message}\n\n请从终端/Web GUI 手动 ./bot.sh restart。`)
        .catch(() => {});
    }
    return true;
  }

  if (!data.startsWith('model:')) return;
  const chosen = routeByKey(data.slice('model:'.length));
  if (!chosen) {
    await telegram.sendMessage(chatId, `未知的模型路由:${data.slice('model:'.length)}`);
    return;
  }
  if (chosen.key === activeRoute.key && runtime.ready) {
    await telegram.sendMessage(chatId, `当前已经是「${chosen.short}」了。`);
    return;
  }

  const previous = activeRoute;
  await telegram.sendMessage(chatId, `⏳ 正在切换到「${chosen.label}」…`);

  await enqueue(chatId, async () => {
    try {
      // ⚠️ 必须在 activateRoute() **之前**写 —— 它会 `state.chats = {}` 清空所有
      // 会话记录（含 createdAt），之后就没法判断"本次会话聊了几条"了。
      // 不足 20 条（反复切模型调试）→ 跳过，不覆盖已有记忆。
      maybeWriteHandoff({ chatId, reason: 'model' });
      await activateRoute(chosen);
      await telegram.sendMessage(
        chatId,
        `✅ 已切换到「${chosen.label}」\n${chosen.provider} / ${chosen.model}\n\n会话已重置,直接发消息即可。`,
      );
    } catch (err) {
      console.error(`[model] 切换到 ${chosen.key} 失败:${err.message}`);
      const { route: restored } = await bootFirstWorkingRoute(previous);
      const tail = restored
        ? `已恢复到「${restored.label}」。`
        : '⚠️ 所有路由都没能启动,请看 bot 日志。';
      await telegram.sendMessage(
        chatId,
        `❌ 切换到「${chosen.label}」失败:${err.message}\n${tail}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Weixin adapter: second entry point, owner-shared session + bidirectional
// mirror. Everything here is isolated from the Telegram path: if the Weixin
// channel is not logged in, or it breaks at runtime, the Telegram bot keeps
// working untouched.
// ---------------------------------------------------------------------------

let weixinCursor = '';
let weixinContextToken = null; // latest context_token from owner for replies

/** 微信镜像进 TG 的消息前缀;TG 侧据此识别并跳过(防 A→B→A 循环)。 */
const WX_MIRROR_TAG = '📱[WX] ';

/** TG 复现进微信的来源前缀,与上面 [微信] 完全对称;
 * 微信侧以 bot 身份发送(message_type=2)不会回流成用户消息,故无循环风险。 */
const TG_MIRROR_PREFIX = '📱[TG] [电报] ';

/** bot 回答(答案)的统一前缀,不管回微信还是回 TG 都用它,表示"这是 DSH 的回答",
 * 与 [微信]/[电报] 这种"复现来源"标识区分开。 */
const REPLY_PREFIX = '[DSH] ';

/** 给回答正文加 [DSH] 前缀;空/纯空白正文原样返回(交给 finish 的"无文字"兜底)。 */
function prefixReply(text) {
  const t = String(text ?? '').trim();
  return t ? REPLY_PREFIX + t : t;
}

/** Mirror a Weixin inbound text to the owner's Telegram chat. */
async function mirrorWxToTelegram(fromWxUserId, text) {
  const body = `${WX_MIRROR_TAG}[微信] ${text}`;
  if (config.allowedUsers.length > 0) {
    for (const uid of config.allowedUsers) {
      try {
        await telegram.sendMessage(uid, body);
      } catch {}
    }
    return;
  }
  if (state.ownerUserId !== null) {
    try {
      await telegram.sendMessage(state.ownerUserId, body);
    } catch {}
  }
}

/**
 * Run a DSH turn driven by a Weixin message, sharing the owner's Telegram
 * session id so TG and Weixin are the *same* conversation (同一个你,无分身).
 * The reply is sent to Weixin and mirrored to the owner's Telegram.
 */
async function runPromptWeixin(fromWxUserId, text, contextToken, imageBlock = null) {
  weixinContextToken = contextToken;
  // 会话锚点 = TG 主人。⚠️ authorize() 在「设置了 TELEGRAM_ALLOWED_USER_IDS」时
  // 走白名单分支、**从不写 state.ownerUserId**（那条 "你已成为主人" 的 claimed
  // 消息也永远不会发），所以这里不能只看 state.ownerUserId，否则白名单一配上
  // 微信入口就永久失效。回退顺序：显式 owner → 白名单里的人。
  const ownerChatId = resolveOwnerAnchor(fromWxUserId);
  if (ownerChatId === null) {
    // 既没有 TG 主人、也没有可用的白名单锚点 —— 用微信自己的 id 建一个会话。
    const record = sessionFor(`wx-${fromWxUserId}`);
    await weixin.sendText(fromWxUserId, '⚠️ 尚未绑定 Telegram 主人,暂时无法使用。', contextToken);
    return;
  }

  const turn = { sessionId: sessionFor(ownerChatId).sessionId };
  saveState();

  let assistantText = '';
  let turnEndReason = null;
  let waiter = null;
  let failedOver = false;
  /** 吐字速度采样器（2026-09-17 加）：与 TG 共用同一口径，标签用 `wx`。 */
  const sampler = new SpeedSampler('wx');

  // 微信侧没有"进度消息"(TOOL_CALL_START/RESULT 实测客户端不渲染,且微信无
  // 编辑消息接口),只能靠"正在输入"状态。
  //
  // ⚠️ 2026-09-16 实测(证据见 memory/lessons.md):
  //   - 只发一次 status=1 → 约 11 秒后自动消失 → agent 跑几分钟时后面全程静默
  //   - 每 4.5s 续期        → 能覆盖整个 turn(60s/14 次、180s/36 次均 0 失败)
  //   - 但客户端渲染有自身节流:约 15 秒后会呈"亮 2s / 灭 2s"闪烁。
  //     这是微信客户端行为,调间隔无法消除,只能接受。
  //
  // 4.5s 对齐 TG 的 LiveStatus.typingTimer;失败不再静默吞掉(否则无法排查)。
  const WX_TYPING_RENEW_MS = 4500;
  let typingTicket = null;
  let typingTimer = null;
  try {
    const cfg = await weixin.getConfig(fromWxUserId, contextToken);
    typingTicket = cfg?.typing_ticket;
  } catch (err) {
    console.error(`[wx] getConfig 失败(无法发送"正在输入"): ${err.message}`);
  }
  if (typingTicket) {
    const renew = () =>
      weixin
        .sendTyping(fromWxUserId, typingTicket, 1)
        .catch((err) => console.error(`[wx] typing 续期失败: ${err.message}`));
    renew();
    typingTimer = setInterval(renew, WX_TYPING_RENEW_MS);
    typingTimer.unref?.();
  }

  const onSessionEvent = ({ sessionId, event }) => {
    if (sessionId !== turn.sessionId) return;
    if (event.type === 'turn/end') {
      turnEndReason = event.data?.reason ?? null;
      return;
    }
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) return;
      const t = content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text ?? block.reasoning ?? '')
        .join('');
      if (t.trim()) {
        assistantText = t;
        // 吐字速度采样（2026-09-17 加）：微信侧原先完全没有这条口径，
        // 与 TG 共用 SpeedSampler 后，尾巴由 deliver() 追加。
        sampler.track(t.length);
      }
    }
  };

  const startTurn = async () => {
    turnEndReason = null;
    // 与 TG 同规则：一轮开始清零采样 + 记整轮起点（兜底计时）。
    sampler.reset();
    waiter?.cancel();
    waiter = runtime.createTurnWaiter(turn.sessionId);
    // ⭐ 与 TG 同一口径：新会话第一条 prompt 自动带上 handoff 记忆
    //    （微信复用主人的 TG session id，所以 chatId 用 ownerChatId）。
    const boot = takeBootstrapPrefix(ownerChatId);
    // 图片场景：先文字块（含 boot 前言），再 image 块 —— 与 TG 侧 prependTextBlock 同序。
    // text 为 null（纯图片消息）时只压图片块，模型仍能看图。
    const blocks = [];
    const headText = `${boot}${text ?? ''}`;
    if (headText) blocks.push({ type: 'text', text: headText });
    if (imageBlock) blocks.push(imageBlock);
    await runtime.prompt(turn.sessionId, blocks);
  };

  const rotateSession = async (notice) => {
    waiter?.cancel();
    assistantText = '';
    turn.sessionId = resetSession(ownerChatId).sessionId;
    if (notice) {
      await weixin.sendText(fromWxUserId, notice, contextToken);
      try {
        await telegram.sendMessage(state.ownerUserId, WX_MIRROR_TAG + notice);
      } catch {}
    }
  };

  const deliver = async (body) => {
    // 回答统一以 [DSH] 开头(区别于 [微信] 这种复现来源标)。
    // 尾巴：与 TG 同一口径（SpeedSampler.finish() 顺带落一条 [tps] 日志）。
    // 微信没有进度消息，所以这里的小尾巴是**唯一**能看到速度的地方。
    const tail = sampler.finish();
    const withTail = (text) => (tail ? `${text}\n\n${tail}` : text);
    // DSH → 节点 → 所有端点。
    // ⛔ 2026-09-19 修：这里原先**先**手工 `weixin.sendText(fromWxUserId, chunk, contextToken)`
    //    循环发一遍，**再** `hubBroadcast()` —— 而 hub 出站是"不排除任何端点"的
    //    （hub.js:156），于是同一条回答发给微信**两次**（用户实测「重复回答两次」）。
    //    那段直发是施工做一半的残留（注释自称"微信走自己那条腿"，与 hub 语义打架）。
    //    ⛔ 不要加回来：端点到节点的出站**只有** hubBroadcast 一条路，
    //    端点自己不许绕过节点直发，否则加第 N 个端点就要再写一遍，且必然重复。
    await hubBroadcast(withTail(prefixReply(body)), '微信回答');
  };

  runtime.on('session-event', onSessionEvent);
  try {
    for (;;) {
      try {
        await startTurn();
      } catch (err) {
        if (!/already exists/i.test(err.message)) throw err;
        await rotateSession('♻️ 微信会话已失效(DSH 或 bot 重启过),已自动开启新会话。');
        await startTurn();
      }

      const finished = await waiter.done;
      if (!finished) {
        await weixin.sendText(fromWxUserId, '❌ 等待回复超时(30 分钟)。', contextToken);
        return;
      }

      if (turnEndReason?.kind === 'error') {
        const failure = turnEndReason.error ?? {};
        const detail = failure.message ?? failure.error?.message ?? '模型调用失败';
        const broken = activeRoute;
        if (!failedOver && isRouteFailure(failure)) {
          const next = await failOverRoute(detail);
          if (next) {
            failedOver = true;
            await rotateSession(`🔁 模型「${broken.label}」不可用,已自动切换到「${next.label}」并重试。`);
            continue;
          }
        }
        await weixin.sendText(fromWxUserId, `❌ 出错了:${detail}`, contextToken);
        return;
      }
      break;
    }

    const body = assistantText.trim();
    // 流水账:记下助手回复(微信侧)。归到主人 chat,与 TG 同一本账。
    ledgerRecord('assistant', body || '(本轮没有文字输出)', ownerChatId ?? `wx-${fromWxUserId}`);
    await deliver(body || '✅ 已完成(本轮没有文字输出)');
  } catch (err) {
    waiter?.cancel();
    const detail = err.message;
    console.error(`[${_ts()}][wx] runPromptWeixin 失败: ${err.stack ?? detail}`);
    try {
      await weixin.sendText(fromWxUserId, `❌ 出错了:${detail}`, contextToken);
    } catch (sendErr) {
      // 报错消息都发不出去 = 通道坏了,必须留痕,不能再静默。
      console.error(`[${_ts()}][wx] 错误提示也无法投递: ${sendErr.message}`);
    }
  } finally {
    runtime.off('session-event', onSessionEvent);
    // 必须先停续期定时器再发 status=2,否则残留的 timer 会在取消后又点亮状态。
    if (typingTimer) clearInterval(typingTimer);
    typingTimer = null;
    if (typingTicket) {
      weixin
        .sendTyping(fromWxUserId, typingTicket, 2)
        .catch((err) => console.error(`[wx] typing 取消失败: ${err.message}`));
    }
  }
}

/** 微信专用命令回复器:把 handleCommand 的每个 case 结果发到微信。 */
async function handleWeixinCommand(fromWxUserId, contextToken, command, arg = '') {
  const send = (text) => weixin.sendText(fromWxUserId, text, contextToken).catch(() => {});

  switch (command) {
    case '/start':
    case '/help':
      await send([
        '👋 我是接在 DeepSeek Harness 上的助手,直接发消息就能用。',
        '',
        '可用命令:',
        '/new — 开启一个全新会话(清空上下文)',
        '/model — 切换模型(' + ROUTES.map(r => r.label).join(' / ') + ')',
        '/restart — 重启 bot 加载新代码（会断开当前会话）',
        '/setupdsh — 升级 DSH&BOT（Git / Node / DSH / 插件）',
        '/status — 查看当前会话和运行状态',
        '/whoami — 查看你的用户 ID',
        '/help — 显示这份帮助',
      ].join('\n'));
      return true;

    case '/new': {
      // 微信共享 owner 的 TG 会话,用 ownerChatId 作为会话锚点
      const wxChatId = resolveOwnerAnchor(fromWxUserId) ?? `wx-${fromWxUserId}`;
      // 同 TG 侧：必须在 resetSession() 之前写，且不足 20 条就跳过。
      maybeWriteHandoff({ chatId: wxChatId, reason: 'new' });
      const record = resetSession(wxChatId);
      await send(`🆕 已开启新会话。\n会话 ID: ${record.sessionId}`);
      return true;
    }

    case '/model': {
      // 不带参数 → 列出编号清单；带参数（编号或 key）→ 直接切换。
      const picks = [...routeChoices];
      const wanted = arg.trim();
      if (!wanted) {
        const lines = [
          '🧠 选择模型',
          '',
          `当前: ${describeRoute(activeRoute)}`,
          '',
          '可用模型:',
          ...picks.map((r, i) => `${i + 1}. ${r.key === activeRoute.key ? '✅ ' : ''}${r.key} (${r.provider} / ${r.model})`),
          '',
          '回复 /model <编号> 直接切换，例如 /model 2',
          '（也认 key，例如 /model ' + (picks.find((r) => r.key !== activeRoute.key) ?? picks[0]).key + '）',
        ].join('\n');
        await send(lines);
        return true;
      }

      // 解析参数：纯数字按编号，否则按 key/label 模糊匹配。
      let chosen = null;
      if (/^\d+$/.test(wanted)) {
        const idx = Number(wanted) - 1;
        if (idx >= 0 && idx < picks.length) chosen = picks[idx];
      } else {
        const low = wanted.toLowerCase();
        chosen =
          picks.find((r) => r.key.toLowerCase() === low) ??
          picks.find((r) => r.label.toLowerCase() === low) ??
          picks.find((r) => r.key.toLowerCase().startsWith(low)) ??
          null;
      }

      if (!chosen) {
        await send(
          `❓ 不认识「${wanted}」。\n` +
            '可用编号:' +
            picks.map((r, i) => `\n${i + 1}. ${r.label}`).join('') +
            '\n\n发 /model 看完整清单。',
        );
        return true;
      }

      if (chosen.key === activeRoute.key && runtime.ready) {
        await send(`当前已经是「${chosen.label}」了。`);
        return true;
      }

      const previous = activeRoute;
      await send(`⏳ 正在切换到「${chosen.label}」…`);

      // 与 TG 侧按钮（model: 回调）保持同一套语义：先写 handoff 再切，
      // 因为 activateRoute() 会清空 state.chats（含 createdAt），之后就没法
      // 判断"本次会话聊了几条"了。不足 20 条则跳过，不覆盖已有记忆。
      const wxChatId = resolveOwnerAnchor(fromWxUserId) ?? `wx-${fromWxUserId}`;
      await enqueue(wxChatId, async () => {
        try {
          maybeWriteHandoff({ chatId: wxChatId, reason: 'model' });
          await activateRoute(chosen);
          await send(
            `✅ 已切换到「${chosen.label}」\n${chosen.provider} / ${chosen.model}\n\n会话已重置,直接发消息即可。`,
          );
        } catch (err) {
          console.error(`[wx][model] 切换到 ${chosen.key} 失败:${err.message}`);
          const { route: restored } = await bootFirstWorkingRoute(previous);
          const tail = restored
            ? `已恢复到「${restored.label}」。`
            : '⚠️ 所有路由都没能启动,请看 bot 日志。';
          await send(`❌ 切换到「${chosen.label}」失败:${err.message}\n${tail}`);
        }
      });
      return true;
    }

    case '/status': {
      const chatKey = resolveOwnerAnchor(fromWxUserId) ?? `wx-${fromWxUserId}`;
      const record = sessionFor(chatKey);
      const ageMinutes = Math.round((Date.now() - record.createdAt) / 60000);
      await send([
        '📊 当前状态',
        `会话 ID: ${record.sessionId}`,
        `已存在: ${ageMinutes} 分钟`,
        `工作目录: ${config.workspace}`,
        `模型: ${activeRoute.key} — ${activeRoute.provider} / ${activeRoute.model}` +
          (() => {
            const effort = reasoningEffortFor(activeRoute, config.reasoningEffort);
            if (effort === 'off') return ' (思考已关闭)';
            return effort ? ` (思考强度 ${effort})` : '';
          })(),
        `权限模式: danger-full-access`,
        `DSH 进程: ${runtime.ready ? '运行中 ✅' : '未运行 ⚠️'}`,
      ].join('\n'));
      return true;
    }

    case '/whoami':
      await send(`你的微信用户 ID: ${fromWxUserId}\n本聊天 ID: wx-${fromWxUserId}`);
      return true;

    case '/restart':
      try {
        // ⚠️ 回执走微信自己的 send（第二个参数）：走 TG 的话是拿微信 id 当 TG chat_id。
        await handleRestartCommand(
          resolveOwnerAnchor(fromWxUserId) ?? `wx-${fromWxUserId}`,
          send,
        );
      } catch (err) {
        console.error(`[wx] /restart failed: ${err.stack ?? err.message}`);
        await send(`❌ 重启失败:${err.message}\n请从终端执行 ./bot.sh restart。`);
      }
      return true;

    case '/setupdsh':
      try {
        // ⚠️ 拉脚本是平台无关的；回执必须走微信自己的 send。原先调 handleSetupdshCommand
        //    会先往 TG 发确认（微信 id）→ chat not found → 脚本永远拉不起来。
        const spawned = spawnSetupdshHelper();
        await send(
          spawned
            ? '⬆️ 已收到升级指令,后台升级 DSH&BOT 中,约 1~2 分钟。升完再点一次 /restart 才生效。'
            : '⚠️ 没找到 setupdsh-helper.sh,没法升级。',
        );
      } catch (err) {
        console.error(`[wx] /setupdsh failed: ${err.stack ?? err.message}`);
        await send(`❌ 升级失败:${err.message}\n请从终端执行:setupdsh`);
      }
      return true;

    default:
      return false;
  }
}

/** Handle one inbound Weixin message from the owner (or reject strangers). */
async function handleWeixinMessage(message) {
  const fromUserId = message?.from_user_id;
  if (!fromUserId) return;

  // 主人专属:只有这里记录的主人(扫码者)能用。to_user_id 是我们自己的 bot。
  const ownerParam = process.env.WEIXIN_ALLOWED_USER_ID?.trim();
  const allowed = ownerParam || weixin.ownerWxUserId;
  if (allowed && fromUserId !== allowed) {
    // 陌生人:礼貌拒绝,但不镜像、不触发 DSH。
    await weixin
      .sendText(fromUserId, '😊 这个微信 bot 只对它的主人开放。', message?.context_token)
      .catch(() => {});
    return;
  }

  // 保持最新 context_token:T→微信方向的回复同步用它,避免用过期 token。
  if (message?.context_token) weixinContextToken = message.context_token;

  // ⚠️ 设计变更（2026-09-27）：微信侧原先「所有媒体一律转纯文本」，语音走转写，
  //   图片**从未实现** → 发图只回「我目前只能处理文字和语音消息」。
  //   现改为与 TG 侧同口径：语音→转写文本；图片→解密后压成 `image` block 交给模型，
  //   让支持视觉的档（本地 VQ / 阿里 / DS）真正看图。
  //   文本块仍保留（文字+图片同时发时两者都在）。
  // 1) 尝试提取文字
  let text = extractText(message);

  // 1.5) 图片：下载 + 解密 → image block
  let imageBlock = null;
  const imageMedia = extractImageUrlFallback(message);
  if (imageMedia) {
    try {
      const img = await downloadWeixinImage(imageMedia);
      imageBlock = { type: 'image', data: img.base64, mimeType: img.mimeType };
      console.log(`[wx] image ready: ${img.base64.length} b64 chars, mimeType=${img.mimeType}`);
    } catch (err) {
      console.error(`[wx] image download failed: ${err.message}`);
      await weixin
        .sendText(fromUserId, `❌ 图片下载失败:${err.message}`, message?.context_token)
        .catch(() => {});
      return;
    }
  }

  // 2) 如果没有文字但有语音,直接走本地下载+解密+Whisper 识别（不依赖服务端 ASR）
  if (text === null) {
    const voiceMedia = extractVoiceUrlFallback(message);
    if (voiceMedia) {
      try {
        text = await transcribeWeixinVoice(voiceMedia, message?.context_token, fromUserId);
        if (!text) {
          await weixin
            .sendText(fromUserId, '⚠️ 语音转文字结果为空，请确认语音内容是否清晰。', message?.context_token)
            .catch(() => {});
          return;
        }
      } catch (err) {
        console.error(`[wx] voice transcribe failed: ${err.message}`);
        await weixin
          .sendText(fromUserId, `❌ 语音转文字失败:${err.message}`, message?.context_token)
          .catch(() => {});
        return;
      }
    }
  }

  // 3) 既无文字也无语音也无图片
  if (text === null && !imageBlock) {
    await weixin
      .sendText(fromUserId, '我目前只能处理文字、图片和语音消息。', message?.context_token)
      .catch(() => {});
    return;
  }

  // 命令优先:以 / 开头的消息走命令处理,不进 AI 对话。
  // ⚠️ 归一化必须与 TG 侧（L1178 `command.toLowerCase().split('@')[0]`）对齐：
  //    TG 侧有 `.toLowerCase()`，微信侧原先**漏了**，于是 `/HELP`、`/Help`
  //    虽能被正则匹配到，却原样丢进 switch → 所有 case 都不中 → `default: return false`
  //    → 静默掉进下面的 AI 对话。表现就是用户说的「发指令没用」。2026-09-19 实测确认：
  //      "/HELP" → wx 原样传 "/HELP"（switch 全不中） vs TG 归一成 "/help"（命中）。
  //    全角斜杠（`／help`）正则本身就匹配不到，属输入法层面的另一类，此处不强行改写。
  // ⚠️ 纯图片消息 text 为 null（原先这里直接 text.match → TypeError 崩在 handler 里，
  //    表现是「图片下载成功但 bot 毫无反应」）。命令只在有文字时才可能命中。
  const slashMatch = text ? text.match(/^\/(\w+)(?:\s+([\s\S]*))?$/) : null;
  if (slashMatch) {
    const command = ('/' + slashMatch[1]).toLowerCase();
    // 参数（如 `/model 2` 里的 `2`）一并传下去，供需要参数的命令使用。
    const handled = await handleWeixinCommand(
      fromUserId,
      message?.context_token,
      command,
      (slashMatch[2] ?? '').trim(),
    );
    if (handled) return;
    // 没匹配到已知命令,继续当普通消息发给 AI
  }

  // 端点 → 节点：这条同步给其他所有端点（TG 等）。
  // 用户定的：「端点到节点，节点同步到 dsh 和其他端点」。
  // ⚠️ 微信的 context_token 要喂给端点缓存 —— 否则广播出去的消息
  //    会因缺 token 被判 `ret=-1 invalid request`（2026-09-19 实测）。
  // ⚠️ 纯图片消息 text 为 null → 广播/记账用占位文字，否则下游拿到 null 会炸。
  const textForHub = text ?? (imageBlock ? '[图片]' : '');
  hub.get('wx')?.rememberContextToken?.(message?.context_token);
  hub.broadcast(
    makeMessage({ source: 'wx', chatId: fromUserId, text: textForHub }),
    { exclude: 'wx', label: '微信入站' },
  ).catch((err) => console.error(`[${_ts()}][hub] 微信入站广播失败: ${err.message}`));

  // 流水账:记下用户原话(微信侧)。归到主人 chat,与 TG 同一本账。
  ledgerRecord('user', textForHub, resolveOwnerAnchor(fromUserId) ?? `wx-${fromUserId}`);

  await enqueue(resolveOwnerAnchor(fromUserId) ?? `wx-${fromUserId}`, () =>
    runPromptWeixin(fromUserId, text, message?.context_token, imageBlock),
  );
}

/**
 * 从 image_item 提取下载信息。返回 { url, aesKey } 或 null。
 *
 * ⚠️ 图片的 aes_key 有两种编码（对齐 SDK `cdn/pic-decrypt.ts` 的 parseAesKey）：
 *   - `image_item.aeskey`：**hex 字符串**（32 个 hex 字符）
 *   - `image_item.media.aes_key`：**base64**（内部再分 16 字节裸 / 32 字符 hex 两型）
 *   这里统一归一成「base64」，喂给 decryptAesEcb，与语音侧同口径。
 */
function extractImageUrlFallback(message) {
  const item = message?.item_list?.find((it) => it?.type === WX_ITEM_TYPE.IMAGE);
  const img = item?.image_item;
  if (!img) return null;
  const media = img.media;
  const url = media?.full_url || null;
  if (!url) return null;
  let aesKey = null;
  const hex = img.aeskey ? String(img.aeskey) : null;
  if (hex && /^[0-9a-fA-F]{32}$/.test(hex)) {
    aesKey = Buffer.from(hex, 'hex').toString('base64');
  } else if (media?.aes_key) {
    aesKey = media.aes_key;
  }
  if (!aesKey) return null;
  return { url, aesKey };
}

/**
 * 下载微信图片并解密，返回 { base64, mimeType }。失败抛错（调用方负责提示）。
 * 与 transcribeWeixinVoice 同一套 CDN + AES-128-ECB 路径。
 */
async function downloadWeixinImage(imageInfo) {
  const { url, aesKey } = imageInfo;
  console.log(`[wx] downloading image from: ${url}`);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${weixin.token}` } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const encrypted = Buffer.from(await res.arrayBuffer());
  const plain = decryptAesEcb(encrypted, aesKey);
  console.log(`[wx] image decrypted: ${plain.length} bytes`);
  // 魔数嗅探：微信图片常见 jpg/png/gif/webp，无扩展名可依，只能看头
  let mimeType = 'image/jpeg';
  if (plain.length > 12) {
    if (plain[0] === 0x89 && plain[1] === 0x50) mimeType = 'image/png';
    else if (plain[0] === 0x47 && plain[1] === 0x49) mimeType = 'image/gif';
    else if (plain[0] === 0x52 && plain[1] === 0x49 && plain[8] === 0x57) mimeType = 'image/webp';
  }
  return { base64: plain.toString('base64'), mimeType };
}

/** 从 voice_item.media 提取下载信息。返回 { url, aesKey } 或 null。 */
function extractVoiceUrlFallback(message) {
  const item = message?.item_list?.find((it) => it?.type === WX_ITEM_TYPE.VOICE);
  if (!item?.voice_item?.media) return null;
  const media = item.voice_item.media;
  // 优先用 full_url（直链），否则用 encrypt_query_param + cdnBaseUrl 拼接
  const url = media.full_url || null;
  const aesKey = media.aes_key || null;
  if (!url || !aesKey) return null;
  return { url, aesKey };
}

/**
 * AES-128-ECB 解密微信 CDN 加密音频数据。
 * @param {Buffer} encrypted - 加密的音频数据
 * @param {string} aesKeyBase64 - base64 编码的 AES 密钥
 * @returns {Buffer} 解密后的原始音频数据（SILK 格式）
 */
function decryptAesEcb(encrypted, aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  let key;
  if (decoded.length === 16) {
    key = decoded;
  } else if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    // hex-encoded key: base64 → hex string → raw bytes
    key = Buffer.from(decoded.toString('ascii'), 'hex');
  } else {
    throw new Error(`aes_key decode failed: got ${decoded.length} bytes`);
  }
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * Wrap raw pcm_s16le bytes in a WAV container.
 * Mono channel, 16-bit signed little-endian at the given sample rate.
 */
function pcmBytesToWav(pcm, sampleRate) {
  const pcmBytes = pcm.length;
  const totalSize = 44 + pcmBytes;
  const buf = Buffer.alloc(totalSize);
  let offset = 0;
  buf.write('RIFF', offset); offset += 4;
  buf.writeUInt32LE(totalSize - 8, offset); offset += 4;
  buf.write('WAVE', offset); offset += 4;
  buf.write('fmt ', offset); offset += 4;
  buf.writeUInt32LE(16, offset); offset += 4; // fmt chunk size (fixed)
  buf.writeUInt16LE(1, offset); offset += 2;  // PCM format
  buf.writeUInt16LE(1, offset); offset += 2;  // mono
  buf.writeUInt32LE(sampleRate, offset); offset += 4;
  buf.writeUInt32LE(sampleRate * 2, offset); offset += 4; // byte rate
  buf.writeUInt16LE(2, offset); offset += 2;  // block align
  buf.writeUInt16LE(16, offset); offset += 2; // bits per sample
  buf.write('data', offset); offset += 4;
  buf.writeUInt32LE(pcmBytes, offset); offset += 4;
  buf.set(pcm, offset);
  return buf;
}

async function transcribeWeixinVoice(mediaInfo, contextToken, fromUserId) {
  const { url, aesKey } = mediaInfo;
  console.log(`[wx] downloading voice from: ${url}`);

  // 1. 下载加密音频文件
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${weixin.token}`,
    },
  });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const encryptedAudio = Buffer.from(await res.arrayBuffer());

  // 2. AES-128-ECB 解密 → SILK 格式音频
  const silkBuf = decryptAesEcb(encryptedAudio, aesKey);
  console.log(`[wx] decrypted voice: ${silkBuf.length} bytes (SILK)`);

  try {
    // 3. silk-wasm: SILK → PCM (24kHz mono, 16-bit LE)
    const { decode } = await import('silk-wasm');
    const decoded = await decode(silkBuf, 24000);
    console.log(`[wx] silk-wasm decoded: duration=${decoded.duration}ms pcmBytes=${decoded.data.byteLength}`);

    // 4. 包装为 WAV 容器（24kHz）
    const wav24k = pcmBytesToWav(new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength), 24000);
    const tmpWav = `/tmp/dsh-weixin-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`;
    writeFileSync(tmpWav, wav24k);

    // 5. ffmpeg: 重采样 24kHz → 16kHz mono PCM WAV (Whisper standard input)
    const wavOut = `${tmpWav}.whisper.wav`;
    execFileSync('ffmpeg', [
      '-y',
      '-i', tmpWav,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      wavOut,
    ], { timeout: 30000 });

    // 6. 语音识别（backend 由 .env 的 ASR_BACKEND 决定：whisper | sensevoice）
    //    ASR_KEEPALIVE=1 时走常驻服务（~0.4s），否则冷启动（~7s）
    const result = await asrTranscribe(wavOut);

    // 7. 清理临时文件
    try { unlinkSync(tmpWav); } catch {}
    try { unlinkSync(wavOut); } catch {}

    if (result) {
      console.log(`[wx] voice transcription for ${fromUserId}: ${result}`);
      return result;
    }
    return null;
  } catch (err) {
    // 清理临时文件
    try { unlinkSync(tmpWav); } catch {}
    try { unlinkSync(wavOut); } catch {}
    throw err;
  }
}


/** Weixin long-poll loop. Independent of (and parallel to) the Telegram loop. */
async function weixinPollLoop() {
  let lastErrorAt = 0;

  while (!shuttingDown) {
    if (!weixin.enabled) return;
    let batch;
    try {
      batch = await weixin.getUpdates(weixinCursor, 30, abortController.signal);
      // 只有业务成功(ret=0)才算通道恢复。HTTP 通了但 ret=-2 时不在这里清 dead，
      // 否则会和下面的 ret=-2 分支形成「秒级死→活→死」抖动，架空 5 分钟节流。
      if (batch?.ret === 0) wxMarkSuccess();
    } catch (err) {
      if (shuttingDown) break;
      const now = Date.now();
      if (now - lastErrorAt > 10000) {
        console.error(`[${_ts()}][wx] getUpdates failed: ${err.message}`);
        lastErrorAt = now;
      }
      wxRecordFailure();
      if (wxChannel.dead) {
        await sleep(wxChannel.DEAD_TIMEOUT_MS);
        continue;
      }
      await sleep(2_000);
      continue;
    }

    // 会话超时(-14)时重置游标,让服务端重新给游标。
    if (batch?.ret === -14) {
      console.error(`[${_ts()}][wx] 会话超时,重置游标后继续`);
      weixinCursor = '';
      continue;
    }

    // 业务错误(-2 prepare failed): context_token 伪过期，清除缓存后等待入站消息恢复。
    if (batch?.ret === -2) {
      if (!wxChannel.dead) {
        console.warn(`[${_ts()}][wx] getUpdates ret=-2 (prepare failed)，已清除本地缓存，等待用户入站消息刷新通道…`);
        try {
          await weixin.reconnect();
          wxMarkSuccess();
          console.log(`[${_ts()}][wx] notifyStart 成功，继续轮询`);
        } catch (err) {
          // notifyStart 也返回 ret=-2: 通道彻底死了，直接标记 dead
          wxChannel.dead = true;
          wxChannel.lastRecoveryAt = Date.now();
          console.warn(`[${_ts()}][wx] 微信通道已死（getUpdates reconnect 失败），暂停出站。等待用户入站消息或 ${wxChannel.DEAD_TIMEOUT_MS / 60000} 分钟后自动重试`);
        }
      } else {
        // 通道已死：不再每 2 秒轮询空转，安静等满 DEAD_TIMEOUT_MS 再试探一次。
        await sleep(wxChannel.DEAD_TIMEOUT_MS);
        wxChannel.lastRecoveryAt = Date.now();
        continue;
      }
      await sleep(2_000);
      continue;
    }

    // 其他业务错误：不推进游标，等用户入站消息刷新。
    if (batch?.ret && batch.ret !== 0) {
      console.warn(`[${_ts()}][wx] getUpdates ret=${batch.ret} errmsg=${batch.errmsg ?? '(none)'}, 等待用户入站消息刷新会话`);
      wxRecordFailure();
      await sleep(2_000);
      continue;
    }

    const msgs = batch?.msgs ?? [];
    for (const msg of msgs) {
      if (!isUserMessage(msg)) continue;
      handleWeixinMessage(msg).catch((err) =>
        console.error(`[${_ts()}][wx] handler error: ${err.stack ?? err.message}`),
      );
    }
    // 只推进游标;已派发的消息不重复(双入口共享会话,由 DSH 去重)。
    if (batch?.get_updates_buf && batch.get_updates_buf !== weixinCursor) {
      weixinCursor = batch.get_updates_buf;
    }
  }
}

/** Mirror owner's Telegram message to Weixin (入站镜像的另一半)。
 * 用 bot 身份发到微信主人,微信侧 message_type=2(BOT) 不会被当用户消息处理,
 * 因此天然不产生回流循环。
 */
async function mirrorTgToWeixin(text) {
  if (!wxCanSend()) return; // 未启用微信入口
  let ownerParam = process.env.WEIXIN_ALLOWED_USER_ID?.trim();
  const target = ownerParam || weixin.ownerWxUserId;
  try {
    await weixin.sendText(target, `${TG_MIRROR_PREFIX}${text}`, undefined);
    wxMarkSuccess();
  } catch (err) {
    // ⚠️ 2026-09-19 修正：**不再**因为 `reconnect()` 失败就判死并 return。
    //    原逻辑拿 notifyStart 当探针，而它本身就刷不了会话（weixin.js:259-263），
    //    必然误判 → 判死 → wxCanSend() 拦死发送 → 永久哑掉。
    //    现在：失败就记录，并且**下一次照发不误**；死没死由真实发送结果说了算。
    wxRecordFailure();
    console.error(`[${_ts()}][wx] TG→微信镜像失败: ${err.message}`);
  }
}

/** 把 bot 的回复也双向同步到微信(TG 入手的回复不能只回 TG)。
 * 与 runPromptWeixin 里的 deliver() 对齐:回复文本发到微信主人一侧。
 * 任出错只记日志,绝不冒泡到 TG 主通道。
 */
async function deliverReplyToWeixin(text) {
  if (!wxCanSend()) return; // 未启用微信入口
  let ownerParam = process.env.WEIXIN_ALLOWED_USER_ID?.trim();
  const target = ownerParam || weixin.ownerWxUserId;
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    try {
      await weixin.sendText(target, chunk, undefined);
      wxMarkSuccess();
    } catch (err) {
      // ⚠️ 2026-09-19 修正：同 mirrorTgToWeixin —— 不再用 reconnect 失败当判死依据，
      //    也不再静默。失败必留痕，且不阻断后续投递尝试。
      wxRecordFailure();
      console.error(`[${_ts()}][wx] 回复同步到微信失败: ${err.message}`);
      return; // 本条投递失败即止（避免同一批 chunk 反复撞墙），但**不改变通道判定**
    }
  }
}

/** Timestamp helper for logs (both wx and tg). */
const _ts = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
};

/**
 * Weixin channel health tracker.
 * When consecutive send failures exceed threshold, marks channel as dead.
 * While dead, all outbound sends are silently skipped (no error logging).
 * Channel recovers automatically when a successful send succeeds (e.g. from
 * an inbound Weixin message that refreshes the session).
 */
const wxChannel = {
  enabled: false,       // mirrors weixin.enabled at call time
  dead: false,          // ⚠️ 仅作"降级提示"，**不再用来拦截发送**（见下）
  consecutiveFailures: 0,
  lastRecoveryAt: 0,
  DEAD_THRESHOLD: 5,    // consecutive failures before marking dead
  DEAD_TIMEOUT_MS: 300_000, // auto-retry after 5 min even if no inbound msg
};

/**
 * Check if weixin channel is usable for outbound.
 *
 * 🚨 2026-09-19 **重大修正**（用户报「微信收不到 DSH 回复」的真凶）：
 *
 *   原实现是「一旦 dead 就 `return false` → **连发都不发**」，后果是
 *   **判死即永久哑掉**：
 *     ① 判死依据是 `reconnect()`（= notifyStart），而 weixin.js:259-263 自己
 *        就写明 **notifyStart 不能刷新会话**，用它判死活必然误判 → 假死。
 *     ② 死掉后 `wxCanSend()` 直接拦住发送 → **不发就不会成功 → 不成功就永远死**
 *        → 只有 5 分钟超时能解，这 5 分钟里用户发的一切都被静默丢弃。
 *     ③ 日志明说 `silently skipped (no error logging)` → **用户端零反馈、日志零痕迹**，
 *        这正是「查了很久查不出来」的原因。
 *
 *   教训：**「判死」不能作为「不发」的理由。** 通道是否活着，只能由**真实发送**
 *   的结果来决定；任何"先判断再决定发不发"的闸门，判错一次就是永久故障。
 *
 *   ⇒ 现在本函数**只回答"能不能尝试发"**（只受 enabled 约束），
 *      dead 状态降级成**仅用于日志提示**，绝不拦截。
 */
function wxCanSend() {
  return Boolean(weixin.enabled);
}

/** Record a successful weixin send — resets dead state and failure counter. */
function wxMarkSuccess() {
  if (wxChannel.dead) {
    console.log(`[${_ts()}][wx] 微信通道已从失效中恢复`);
  }
  wxChannel.dead = false;
  wxChannel.consecutiveFailures = 0;
  wxChannel.lastRecoveryAt = Date.now();
}

/** Record a failed weixin send — increments counter, may mark dead. */
function wxRecordFailure() {
  wxChannel.consecutiveFailures += 1;
  if (wxChannel.consecutiveFailures >= wxChannel.DEAD_THRESHOLD && !wxChannel.dead) {
    wxChannel.dead = true;
    console.warn(`[${_ts()}][wx] ${wxChannel.DEAD_THRESHOLD} 次连续发送失败，通道已暂停（等待用户入站消息或 ${wxChannel.DEAD_TIMEOUT_MS / 60000} 分钟后自动重试）`);
  }
}

// ---------------------------------------------------------------------------
// Long polling loop
// ---------------------------------------------------------------------------

const abortController = new AbortController();
let shuttingDown = false;

/** Queued updates older than this are skipped after a long outage. */
const BACKLOG_MAX_AGE_SECONDS = 2 * 60 * 60;

async function pollLoop() {
  // Resume from the last update we actually consumed. The previous version
  // probed with `getUpdates(-1)` and jumped the offset past the newest queued
  // update, which told Telegram those were all received — silently discarding
  // every message sent while the bot was down, with a clean log to hide it.
  let offset = (state.lastUpdateId ?? 0) + 1;
  if (state.lastUpdateId !== null) {
    console.log(`[tg] 从 update ${state.lastUpdateId} 之后继续(停机期间的消息会补上)`);
  }

  while (!shuttingDown) {
    let updates;
    try {
      updates = await telegram.getUpdates(offset, 30, abortController.signal);
    } catch (err) {
      if (shuttingDown) break;
      // Telegram hands updates to exactly one poller. A second process using the
      // same token gets 409 for its whole lifetime, so every message it "misses"
      // looks like the bot randomly ignoring you. Die loudly instead of looping.
      if (isConflict(err)) return conflictExit();
      // AbortError during shutdown is normal (SIGTERM → abortController.abort());
      // only log real failures.
      if (!/abort/i.test(err.message ?? '')) {
        console.error(`[${_ts()}][tg] getUpdates failed: ${err.message}`);
      }
      await sleep(3000);
      continue;
    }

    let newest = null;
    let skippedStale = 0;
    for (const update of updates) {
      newest = update.update_id;

      // Telegram retains up to 24h. Acting on a day-old request is worse than
      // ignoring it — the agent has shell and file access — so skip it, but say
      // so rather than dropping it invisibly.
      const sentAt = update.message?.date ?? update.callback_query?.message?.date;
      if (typeof sentAt === 'number' && Date.now() / 1000 - sentAt > BACKLOG_MAX_AGE_SECONDS) {
        skippedStale += 1;
        continue;
      }

      if (update.message) {
        handleMessage(update.message).catch((err) =>
          console.error(`[bot] handler error: ${err.stack ?? err.message}`),
        );
      }
      if (update.callback_query) {
        handleCallbackQuery(update.callback_query).catch((err) =>
          console.error(`[bot] callback error: ${err.stack ?? err.message}`),
        );
      }
    }

    if (skippedStale > 0) {
      console.error(`[tg] 跳过 ${skippedStale} 条超过 2 小时的积压消息(停机太久,旧请求不再执行)`);
    }
    // Advance the cursor for the NEXT poll, and persist it.
    // ⚠️ Both halves are required. Persisting without advancing `offset` makes
    // `getUpdates` hand back the same batch on every iteration — an infinite
    // replay that floods the chat (this exact bug shipped on 2026-09-12).
    // Handlers are fire-and-forget (a turn can run for minutes), so the saved id
    // records "dispatched", not "answered": a crash mid-turn still loses it.
    if (newest !== null) {
      offset = newest + 1;
      if (newest !== state.lastUpdateId) {
        state.lastUpdateId = newest;
        saveState();
      }
    }
  }
}

/** Telegram returns 409 when another process is polling the same bot token. */
function isConflict(err) {
  return err?.errorCode === 409 || /terminated by other getUpdates/i.test(String(err?.description ?? err?.message ?? ''));
}

function conflictExit() {
  console.error('');
  console.error('[bot] ❌ 409 Conflict:另一个进程正在用同一个 bot token 收消息。');
  console.error('[bot] 现在这个进程收不到任何消息,所以直接退出,免得你以为 bot 还活着。');
  console.error('[bot] 常见原因:');
  console.error('[bot]   1. 手动 ./bot.sh start 起了两份;');
  console.error('[bot]   2. 上次没停干净,或者 pid 文件丢了导致重复启动。');
  console.error(`[bot] 处理:在 ${APP_DIR} 执行  ./bot.sh stop  (它会清理本目录的 bot 进程),再重新启动。`);
  process.exit(3);
}

// ---------------------------------------------------------------------------
// 实例锁（.bot.lock）—— 由 **bot.js 自己**维护，而不是启动脚本
// ---------------------------------------------------------------------------
/**
 * ⚠️ 2026-09-19 修「/restart 后 pidfile 指着一个死进程」（real bug，不是显示问题）：
 *
 * 锁文件原先**只有 `bot.sh cmd_start` 会写**（bot.sh:157-158）。而 `/restart` 走的是
 * `restart-helper.sh`，它**只 spawn 新进程、从不回写 pid**（老代码 line 124-131 只是
 * *读回*锁里的值来打印）→ 锁里永远留着**被它杀掉的旧 pid**。
 *
 * 后果（本次实测）：
 *   - `./bot.sh status` 误报「未运行（残留 pidfile）」——而 bot 明明活着；
 *   - `./bot.sh stop` 杀不到真进程 → 只能靠 409 撞死，或留孤儿；
 *   - 真正在跑的那个 pid 完全**不受管**（本次是 5913，锁里却是死掉的 22128）。
 *
 * ✅ 修法：让**进程自己**在启动时认领锁、在退出时释放。
 *    这样无论从哪条路径拉起（bot.sh / restart-helper.sh / 双击 .command / 手动 node），
 *    锁都必然是真 pid —— 单一事实源，不再依赖调用方的自觉。
 */
const LOCK_DIR = join(ROOT, '.bot.lock');
const PID_FILE = join(ROOT, '.bot.pid');

function claimInstanceLock() {
  try {
    mkdirSync(LOCK_DIR, { recursive: true });
    writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
    // mode 只写一次，保留调用方（bot.sh 的 manual / restart 等）已声明的来源。
    if (!existsSync(join(LOCK_DIR, 'mode'))) {
      writeFileSync(join(LOCK_DIR, 'mode'), process.env.HARNESS_BOOT_MODE || 'manual');
    }
    writeFileSync(PID_FILE, String(process.pid));
  } catch (err) {
    console.error(`[bot] 写实例锁失败(不影响运行): ${err?.message ?? err}`);
  }
}

function releaseInstanceLock() {
  // 只在锁确实归本进程时才删，避免误删另一个刚起来的实例的锁。
  try {
    const cur = readFileSync(join(LOCK_DIR, 'pid'), 'utf8').trim();
    if (cur === String(process.pid)) {
      rmSync(LOCK_DIR, { recursive: true, force: true });
      rmSync(PID_FILE, { force: true });
    }
  } catch {
    /* 锁不存在或读不到 —— 没什么要释放的 */
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[bot] ${signal} received, shutting down…`);
  abortController.abort();
  releaseInstanceLock();

  // ⚠️ 2026-09-19 修「重启撞 409 自杀」的第二半（第一半在 restart-helper.sh 杀进程组）：
  //    原来这里 `.finally(() => process.exit(0))` —— 一旦 runtime.stop() 抛错或超时，
  //    我们立刻 exit，**而 dsh 子进程（`dsh --profile bot`）可能还活着**并继续持有
  //    Telegram token。新实例随后 getUpdates 就撞 409 → 自杀（bot.log 13:38 / 14:10 两次）。
  //    ✅ 改为：先确保子进程真的退出，再 exit；兜底超时留足 12s。
  const hardExit = setTimeout(() => {
    console.error('[bot] shutdown 超时(12s)，强制退出');
    process.exit(0);
  }, 12000);
  hardExit.unref();

  runtime
    .stop()
    .catch((err) => {
      console.error(`[bot] runtime.stop() 异常(已忽略): ${err?.message ?? err}`);
    })
    .finally(() => {
      clearTimeout(hardExit);
      // 给 dsh 子进程的退出事件一点时间落到 #onExit，避免"父进程已走、子进程仍在轮询"。
      setTimeout(() => process.exit(0), 300);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Retry a call that can fail for transient network reasons. A laptop waking
 * from sleep or a Wi-Fi blip should not leave the user staring at a stack trace.
 */
async function withRetry(label, fn, attempts = 5, baseDelayMs = 2000) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const detail = err?.cause?.code ?? err?.cause?.message ?? err.message;
      // `fetch failed` is all undici puts on the TypeError; the real reason is
      // in `cause` (e.g. UND_ERR_CONNECT_TIMEOUT, ECONNREFUSED). Consider both.
      const transient =
        err?.errorCode === undefined &&
        /fetch failed|UND_ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed/i.test(
          `${detail} ${err?.message ?? ''}`,
        );
      if (!transient || attempt === attempts) break;
      const delay = baseDelayMs * attempt;
      console.error(
        `[tg] ${label}失败(${detail}),${delay / 1000}s 后重试 [${attempt}/${attempts - 1}]`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

let botInfo;
try {
  botInfo = await withRetry('连接 Telegram', () => telegram.getMe());
} catch (err) {
  const detail = err?.cause?.code ?? err?.cause?.message ?? err.message;
  console.error('');
  console.error('[bot] ❌ 连不上 Telegram,启动中止。');
  console.error(`[bot] 原因:${detail}`);
  console.error('[bot] 常见情况:');
  console.error('[bot]   1. 网络不通 —— 先在浏览器打开 https://api.telegram.org 试试;');
  console.error('[bot]   2. 代理开着但 Telegram 能通、DeepSeek 反而不通 —— 给 DSH 加 NO_PROXY 排除。');
  process.exit(1);
}

console.log(`[bot] logged in as @${botInfo.username} (${botInfo.id})`);
// 登录成功才认领实例锁：启动失败（比如网络不通）不该留下一个指向死进程的锁。
claimInstanceLock();
console.log(`[bot] workspace: ${config.workspace}`);
console.log(`[bot] model: ${activeRoute.key} — ${activeRoute.provider}/${activeRoute.model}`);
if (config.allowedUsers.length > 0) {
  console.log(`[bot] restricted to user ids: ${config.allowedUsers.join(', ')}`);
} else if (state.ownerUserId !== null) {
  console.log(`[bot] owner user id: ${state.ownerUserId}`);
} else {
  console.log('[bot] no owner yet — the first person to message this bot claims it');
}

await telegram
  .setMyCommands([
    { command: 'new', description: '开启新会话' },
    { command: 'model', description: '切换模型' },
    { command: 'restart', description: '重启 bot 加载新代码' },
    { command: 'setupdsh', description: '升级 DSH&BOT' },
    { command: 'status', description: '查看当前状态' },
    { command: 'whoami', description: '查看我的用户 ID' },
    { command: 'help', description: '显示帮助' },
  ])
  .catch((err) => console.error(`[bot] setMyCommands failed: ${err.message}`));

console.log('[dsh] starting runtime…');
const preferredRoute = activeRoute;
const boot = await bootFirstWorkingRoute(preferredRoute);
if (boot.route) {
  if (boot.failures.length > 0) {
    console.error(`[model] 默认路由「${preferredRoute.short}」不可用,已回退到「${boot.route.short}」`);
    console.error(`[model] 失败详情:${boot.failures.join('; ')}`);
    if (state.ownerUserId !== null) {
      // Best effort: a private chat's id equals the user id.
      telegram
        .sendMessage(
          state.ownerUserId,
          `⚠️ 默认模型「${preferredRoute.short}」启动失败,已自动回退到「${boot.route.short}」。\n\n` +
            boot.failures.map((f) => `• ${f}`).join('\n') +
            '\n\n可用 /model 手动切换,或修好后重启。',
        )
        .catch((err) => console.error(`[model] 回退通知发送失败:${err.message}`));
    }
  }
  console.log(`[bot] ready — model ${activeRoute.provider}/${activeRoute.model}`);
  // If the previous process died mid-turn, that message's reply never went out
  // and Telegram will not redeliver it. Tell the owner rather than stay silent.
  await warnAboutLostTurn();
  // 断开前没来得及写 handoff 的场合（重启电脑/launchd 拉起/崩溃自愈）在此补上。
  await catchUpHandoffOnBoot();
} else {
  // All routes failed. Final fallback: try 'ds' (deepseek-official) which has
  // native SDK jsonrpc-server support (it auto-loads LlmDeepSeek as a fallback).
  // The first attempt may have hit a Cordis timing issue; retry once with a brief delay.
  const fallback = routeByKey('ds');
  if (fallback) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      await activateRoute(fallback, { rotateSessions: false, persist: false });
      boot = { route: fallback, failures: [...boot.failures, `兜底(延迟重试): ${fallback.short}`] };
    } catch (err) {
      console.error(`[model] 兜底路由 ds 也失败: ${err.message}`);
      console.error(`[dsh] 所有模型路由都没能启动:${boot.failures.join(' | ')}`);
      console.error('[dsh] the bot keeps running and retries in the background;');
      console.error(`[dsh] if this persists, run \`dsh --profile ${config.profile}\` by hand to see why.`);
    }
  }
}

// ---------------------------------------------------------------------------
// 节点（hub）—— 所有端点的唯一交汇点
// ---------------------------------------------------------------------------
// 用户 2026-09-19 定的架构：
//   入站：TG/微信/第N ─→ [节点] ─┬─→ DSH
//                                └─→ 其他所有端点
//   出站：DSH ─→ [节点] ─→ 所有端点
//
// ⛔ 不要加去重：用户原话「tg 和微信各进来一条，为什要去重？」
// ⛔ 不要再写成对镜像：那是 O(n²)，加 N 个端点要写 2N 条。
//
// 端点适配器在 endpoints/tg.js / endpoints/wx.js，只管自己的协议。
// 下面这个 hub 实例只负责「归一 → 广播」，不认识任何具体协议。
import { Hub, makeMessage, markAsHubOutput } from './hub.js';

const hub = new Hub({
  log: (line) => console.log(`[${_ts()}]${line}`),
  // ⛔ 投递失败告警已按用户要求**删除**（2026-09-19）。
  //    曾短暂加过 onDeliveryFailure：广播失败时直发 TG + 微信提醒。
  //    用户看过后决定不要这个提示，故移除；hub.js 侧的回调支持保留（不传即不触发）。
  //    失败信息仍照旧写在 bot.log 里（`[hub] … 失败 [wx]`），要查去翻日志。
});

/** 端点就绪标志。 */
let hubReady = false;

/**
 * DSH 的输出统一从节点广播到所有端点。
 * 这是「DSH → 节点 → 所有端点」那一半。
 */
async function hubBroadcast(text, label = 'DSH 输出', { exclude = null } = {}) {
  if (!hubReady) return;
  try {
    await hub.outbound(text, { label, exclude });
  } catch (err) {
    // 广播失败绝不冒泡到主通道（DSH 的回合逻辑不该被端点故障打断）。
    console.error(`[${_ts()}][hub] 广播失败: ${err.stack ?? err.message}`);
  }
}

// ---- Weixin 入口(可选,第二接入层)----
// 若 weixin-account.json 存在则启用微信长轮询,与 Telegram 并行。
// 微信不可用(未登录/凭据缺失/运行出错)绝不影响 Telegram 主通道。
const wxLoaded = weixin.load();
if (wxLoaded) {
  console.log(
    `[${_ts()}][wx] 已启用微信入口 -- bot ${weixin.botId || '(待确认)'} 主人: ${weixin.ownerWxUserId || '(待确认)'}`,
  );
  if (config.allowedUsers.length === 0) {
    console.warn(`[${_ts()}][wx] ⚠️ 未设置 TELEGRAM_ALLOWED_USER_IDS,微信会话将锚定在 TG 主人(id) 上。`);
  }
  weixin.notifyStart().catch(() => {});

  // 保活（filehelper 心跳）已于 2026-09-15 删除，原因：
  //   1. 定时器被自己上面的 lastRecoveryAt 条件永久短路，从未真正发出过心跳；
  //   2. 即便发出，ret=-2 时 sendText 必然抛错，无法"激活"通道；
  //   3. "向 filehelper 发空消息可绕过 ret=-2" 是未经实证的假设。
  // 真正的恢复判据只有一个：用户入站消息带来新鲜 context_token。
} else {
  console.log(`[${_ts()}][wx] 未检测到 weixin-account.json,微信入口未启用(不影响 Telegram)。`);
  console.log(`[${_ts()}][wx] 要启用: cd ${APP_DIR} && node weixin-login.mjs,再重启 BOT`);
}

// ---- 模型清单同步（单一权威源 + 广播到各 profile）----
// 同步规则、安全断言、备份与原子替换全在 sync-model-blocks.mjs 头注释里，这里只是接线。
// ⚠️ 为什么放在 bot 进程里而不是让用户双击脚本：桌面版/网页版的 profile 在 ~/.dsh/**，
//    工作区沙箱之外，只有 bot 这个常驻进程能合法写；bot 不在时同步自然暂停，下次启动补齐。
// ⚠️ 托管块只有 llm-pi-ai / llm-deepseek（模型清单）；界面偏好、agent-default-model、
//    桌面端手写的 hard-rules 段一律原样保留。
try {
  const { startWatch } = await import('./sync-model-blocks.mjs');
  startWatch({ log: (line) => console.log(`[${_ts()}]${line}`) });
} catch (err) {
  console.error(`[${_ts()}][modelsync] ⛔ 启动失败（不影响 bot 本体）: ${err.message}`);
}

// ---- 节点端点注册 ----
// 端点适配器只管自己的协议（怎么发、怎么渲染），节点只管广播。
// ⚠️ 入站仍走下面的 pollLoop() / weixinPollLoop()（已验证的逻辑，先不动）；
//    本次先让 hub 接管**出站广播**，这是风险最小的一步。
//    入站归一化（让 pollLoop 也走 hub.inbound）是下一步，等出站验证稳定。
// ⚠️ 必须放在 `wxLoaded` **之后** —— 这里要复用它已经 load 好的实例。
//    （2026-09-19 踩过：放前面 → TDZ 报错 `Cannot access 'wxLoaded' before initialization`，
//     且 test-cursor.mjs 会直接挂。）
{
  const { TelegramEndpoint } = await import('./endpoints/tg.js');
  const { WeixinEndpoint } = await import('./endpoints/wx.js');

  hub.add(new TelegramEndpoint({
    token: config.token,
    allowedUsers: config.allowedUsers,
    ownerUserId: state.ownerUserId,
    // ⚠️ 动态读主人：启动时可能是 null（白名单模式下 authorize() 之前不认领），
    //    用 getter 才能拿到后来认领的值。否则「微信入站 → tg」永远 chat not found。
    getOwner: () => state.ownerUserId ?? resolveOwnerAnchor(null),
    log: (line) => console.log(`[${_ts()}]${line}`),
  }));

  const wxEp = new WeixinEndpoint({
    ownerUserId: process.env.WEIXIN_ALLOWED_USER_ID?.trim() || weixin.ownerWxUserId,
    log: (line) => console.log(`[${_ts()}]${line}`),
  });
  if (wxLoaded) {
    wxEp.weixin = weixin;           // 复用已 load 的实例，避免二次读凭据
    wxEp.ownerUserId = wxEp.ownerUserId || weixin.ownerWxUserId;
  }
  hub.add(wxEp);

  hubReady = true;
  console.log(`[${_ts()}][hub] 节点已就绪，端点: [${hub.ids().join(', ')}]`);
}

await Promise.all([pollLoop(), weixinPollLoop()]);

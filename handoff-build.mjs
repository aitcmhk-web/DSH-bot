/**
 * handoff 内容构建的**纯函数**部分（任务表 #35 小工注入瘦身，2026-10-08 从 bot.js 抽出）。
 *
 * 抽成独立模块只有一个目的：让测试能直接驱动**真实代码**（而不是复制一份算法来测，
 * lessons 第 22 条：复制算法的测试 = 没测接线）。
 *
 * 任务表 #35（2026-10-08）：handoff 写入加裁剪——只留「最近 20 条 + 活跃任务」，
 * 单条封顶截断，老账靠流水账（ledger-tail 可查）。条数 20 = 老板 2026-09-16 定死不许动
 * （「重启前文件=最新倒数取 20 条」；曾擅改 30，同日验收打回改回）。
 * #35 取代的是旧「🤖 正文不截断」——20 条不截断实测长到 22KB。
 */

import { classifyUserText } from '../memory/conversation-cache/summarizer.mjs';
import { existsSync, readFileSync } from 'node:fs';

/**
 * 单条条目正文的字符封顶（JS 字符数，非字节）。
 * 实测（#35）：2026-10 账本单条均长 259–674 字符，20 条不截断 = handoff 22KB；
 * 封顶 150 字符后 handoff ≈ 减半。标题句都在条目开头，细节去流水账查。
 */
export const ENTRY_CAP_CHARS = 150;

/** 活跃任务行在任务表里可能出现的非终态（终态 = 已发布 / 行删）。 */
export const ACTIVE_TASK_STATES = ['待领取', '进行中', '待验收', '验收中', '待审核', '打回'];

/**
 * 判定某条 👤 发言是不是无信息量的语气词（「嗯」「好」这类）。
 * 判不了就保留：宁可多留不可误杀。
 */
export function isFillerEntry(body, seen) {
  try {
    return classifyUserText(body, seen).action === 'drop';
  } catch {
    return false;
  }
}

/** 单条正文封顶：超长留头部 + 截断标记（指向流水账）。 */
export function capEntryBody(body, capChars = ENTRY_CAP_CHARS) {
  const text = String(body ?? '');
  if (text.length <= capChars) return { text, truncated: false };
  return {
    text: text.slice(0, capChars) + '……（截断，全文见流水账 ledger-tail）',
    truncated: true,
  };
}

/**
 * 读流水账正文，取「有用的」末尾 maxEntries 条，单条封顶后压成引用块。
 *
 * 口径沿革：
 *   - 2026-09-16 用户定：不是机械数条数，先用语气词表筛掉无信息量的 👤
 *     （其所属整轮 🤖 一并丢弃），再取末尾条目；复用摘要链路 classifyUserText()。
 *   - 2026-10-08 #35：**单条封顶截断**（取代旧「🤖 正文不截断」——不截断实测把
 *     handoff 撑到 22KB；被截掉的部分流水账里逐字都在，不丢信息，只省注入）。
 *     条数仍是 20：老板 2026-09-16 定死；曾擅改 30，同日验收打回改回。
 *
 * @param {string|null} ledgerRaw 流水账**正文**（调用方先 readLedgerText() 读好传入）
 * @param {number} maxEntries 取末尾多少条（默认 20 = 老板 2026-09-16 定死）
 * @param {number} capChars 单条正文封顶字符数（默认 ENTRY_CAP_CHARS）
 * @returns {string} 可直接嵌入 markdown 的正文；读不到时返回提示串
 */
export function readRecentLedgerEntries(ledgerRaw, maxEntries = 20, capChars = ENTRY_CAP_CHARS) {
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

    // 按时序把条目切成「轮」——每遇到一条 👤 就开新轮，其后的 🤖 归属该轮。
    // 轮内 👤 无信息量 → 整轮丢弃；否则整轮保留（判据见 isFillerEntry）。
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
      const capped = capEntryBody(e.body, capChars);
      // 正文可能是多行（回答里有缩进代码块），统一压成引用块
      const quoted = capped.text
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n');
      return `### ${e.icon} ${e.who} · ${e.ts}\n${quoted}`;
    }).join('\n\n');

    const userCount = picked.filter((e) => e.icon === '👤').length;
    const asstCount = picked.filter((e) => e.icon === '🤖').length;
    const capNote = picked.some((e) => e.body.length > capChars) ? '；单条超长已截断' : '';
    return `（共 ${picked.length} 条：👤 用户 ${userCount} / 🤖 助手 ${asstCount}${capNote}）\n\n${out}`;
  } catch (err) {
    return `（读取流水账失败：${err.message}）`;
  }
}

/**
 * 任务表「活跃任务」快照（#35 新增：handoff 只留最近 20 条 + 活跃任务）。
 *
 * 只取非终态行（待领取/进行中/待验收/验收中/待审核/打回），每行压成一行：
 * `- #编号 [状态] 负责=谁：任务首段(≤80字)`。终态（已发布等）一律不进 handoff。
 *
 * @param {string} taskTablePath 任务表绝对路径
 * @returns {string} markdown 片段（读不到/为空也返回说明串，绝不抛出）
 */
export function activeTaskSnapshot(taskTablePath) {
  try {
    if (!existsSync(taskTablePath)) return '（任务表不存在）';
    const lines = readFileSync(taskTablePath, 'utf-8').split('\n');
    const active = new Set(ACTIVE_TASK_STATES);
    const rows = [];
    for (const line of lines) {
      // 行形状：| 编号 | 任务 | 负责 | 状态 | 结论 |
      const m = line.match(/^\|\s*(\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/);
      if (!m) continue;
      const status = m[4].trim();
      if (!active.has(status)) continue;
      const task = m[2].trim();
      rows.push(`- #${m[1]} [${status}] 负责=${m[3].trim()}：${task.length > 80 ? task.slice(0, 80) + '…' : task}`);
    }
    if (rows.length === 0) return '（无进行中的任务行）';
    return rows.join('\n');
  } catch (err) {
    return `（任务表读取失败：${err.message}）`;
  }
}

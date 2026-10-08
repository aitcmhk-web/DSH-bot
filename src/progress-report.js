/**
 * src/progress-report.js — 每 5 分钟例行进度汇报·主 bot 侧巡检（任务 #41，2026-10-08）。
 *
 * 老板令（权威源=AITCM/04-开发总设计.md 开发纪律第 5 条/D16）：主 bot 每 5 分钟扫任务表
 * 「进行中」行，让对应小工在协作群报一次进度（①本单进展到哪一步 ②下一步干什么
 * ③需要解决的问题，无也要报无）。
 *
 * 任务书原文「对应 bot 会话进程内注入」的落法（为什么拆成两半）：
 *   小工会话活在小工自己的进程里（bot.js worker 分支 + 各自 token），master 的 runtime
 *   只够得着自己进程的会话（runtime.js #sessions 按本进程 chatKey 隔离）；TG 平台又不投
 *   bot 的发言（bot→bot 平台层就拦，triggers.js 头注释同款结论）。两边唯一共享账本 =
 *   任务表（派活/交活/打回走的就是它）。所以：
 *     - master 侧（本文件）：每 5 分钟在「进行中」行结论列落请求标记
 *       「⏰ 汇报请求(MM-DD HH:MM)」——年龄判据挂表上，进程重启不丢；
 *     - worker 侧（bot.js 领活轮询里捡标记）：见标记 → submitTurn(固定提示词) 进协作群
 *       （=领活同款通路），投递前剥标记；忙（在途回合未清）→ 只把标记时间戳刷新
 *       （=活着证明），不投递——防堆叠（followup 排队语义下再排只会堆积，
 *       mgmt-round.js 同款 rationale）。
 *
 *   升级判据（任务书「连续 2 个周期未报 → 该行交看门狗按卡死处置」）：标记挂着
 *   ≥PROGRESS_ESCALATE_MS（2×5 分钟，跟着 HERD_CHECK_MS 同源走）没被刷新/剥掉 =
 *   连续 2 个周期无回应 → 公告 + reassignTaskRow 翻「待领取」（=看门狗对停摆行的
 *   同款处置，第 1 条：不复制第二份改派逻辑）。worker 忙时每 ≤PROGRESS_RECHECK_MS
 *   刷新一次标记（门槛严格小于一个巡检周期），所以「10 分钟纹丝不动」只可能是
 *   小工侧捡标记的腿断了（进程死/轮询死/投递持续失败），不会误伤长回合干活的小工。
 *
 * 同拍复用（第 1 条，⛔ 不新造定时器）：tick 由 src/herd.js 看门狗定时器每 5 分钟一拍
 *   地带起来（onHeartbeat），与 #34 例行管理回合并列挂载、各判各的（#34 自判
 *   「距上次 ≥30 分钟」，本模块自判每行标记年龄——两族拍子零共享状态，互不覆盖，
 *   派单打回原因点名防的就是这个）。角色门在 src/index.js 接线处：只有
 *   BOT_ROLE=master 的实例挂。本模块无自有定时器/锁，dispose 随 herd.stop() 停。
 *
 * 失败重试不丢：写标记/剥标记/改派任何一步抛错 → 行保持原样或半程，下一拍自然重试
 *   （标记没写成=下拍重写；标记剥了改派没成=行还在「进行中」，下拍按无标记行重新
 *   起一轮请求——无静默丢失，最坏多等一拍）。
 *
 * 依赖全部注入（读表/写表/公告/日志），测试不碰真表真群（test-progress-report.mjs）。
 */

import { HERD_CHECK_MS, WORKER_NAMES, reassignTaskRow } from './herd.js';

/** 例行进度汇报固定提示词（任务 #41 原文一字不改）。投递在 worker 侧 bot.js——
 *  那边是 CJS import 不了本 ESM 模块，bot.js 有一份同文常量，双侧测试互为对照。 */
export const PROGRESS_REPORT_PROMPT =
  '例行进度汇报：①本单进展到哪一步 ②下一步干什么 ③需要解决的问题（无也要报无）';

/** 升级阈值：标记 2 个巡检周期无回应 = 连续 2 周期未报（同源 HERD_CHECK_MS，别单方面改）。 */
export const PROGRESS_ESCALATE_MS = 2 * HERD_CHECK_MS;

/** worker 忙时刷新标记的门槛：严格小于一个巡检周期（4 分钟 < 5 分钟一拍）——
 *  master 每拍看到的在途标记永远新鲜，升级判据只可能被真断腿触发（见头注释）。
 *  bot.js（CJS）有一份同值同义常量，双侧测试互为对照。 */
export const PROGRESS_RECHECK_MS = 4 * 60 * 1000;

/** 请求标记（契约文本）：时间戳与 herd.js localStamp 同形（MM-DD HH:MM），人可读。 */
export const PROGRESS_MARKER_TEXT = '⏰ 汇报请求';
export const PROGRESS_MARKER_RE = /⏰ 汇报请求\((\d{2}-\d{2} \d{2}:\d{2})\)/;

/** 时间戳格式化（与 herd.js localStamp 同形；herd 未导出，契约文本以本模块为准）。 */
export function progressStamp(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 时间戳解析回毫秒（本机本地时区）。跨年边界：解析结果若落在未来 1 天外按去年算。 */
export function parseProgressStamp(s, now = Date.now()) {
  const [md, hm] = String(s).split(' ');
  const [mo, d] = md.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  let t = new Date(new Date(now).getFullYear(), mo - 1, d, h, mi).getTime();
  if (t - now > 24 * 60 * 60 * 1000) {
    t = new Date(new Date(now).getFullYear() - 1, mo - 1, d, h, mi).getTime();
  }
  return t;
}

/** 把请求标记写进行结论列（「；」分隔约定与 reassignTaskRow 同款）。返回新行文本。 */
export function appendMarkerToLine(line, now = Date.now()) {
  const cells = line.split('|');
  if (cells.length < 6) return line;
  const prev = (cells[5] ?? '').trim();
  cells[5] = ` ${(prev && prev !== '—' ? `${prev}；` : '') + `${PROGRESS_MARKER_TEXT}(${progressStamp(now)})`} `;
  return cells.join('|');
}

/** 从行里剥掉标记（升级改派前清场 / worker 领活占位清陈旧标记，契约同款）。
 *  bot.js（CJS）有同文实现 stripProgressMarkerNote，双侧测试互为对照。返回新行文本。
 *  ⚠️ 单元格保持表约定形状 ` 内容 `（两侧空格），round-trip 严格还原原行。 */
export function stripMarkerFromLine(line) {
  const cells = line.split('|');
  if (cells.length < 6) return line;
  const stripped = cells[5]
    .split('；')
    .filter((seg) => !PROGRESS_MARKER_RE.test(seg))
    .join('；')
    .trim();
  cells[5] = ` ${stripped} `;
  return cells.join('|');
}

/** 任务表数据行解析（bot.js / herd.js parseRow 同款正则：no / task / owner / status）。 */
function parseRow(line) {
  return line.match(/^\|\s*(\d+)\s*\|([^|]+)\|\s*([^\s|]+)\s*\|\s*([^|]+?)\s*\|/);
}

/**
 * 一拍巡检（每 5 分钟，herd onHeartbeat 带起）：扫「进行中」的小工行——
 *   无标记 → 落请求标记（本周期请求发出，等 worker 捡；写失败=行不动，下拍重写）；
 *   标记在途且新鲜 → 跳过（防堆叠：一行同时只挂一个请求，不重写不加码）；
 *   标记 ≥PROGRESS_ESCALATE_MS 无回应 → 公告 + 剥标记 + 交看门狗改派（翻「待领取」）。
 *
 * deps = { readTable, writeTable, announce, log, error }。
 * 无跨拍状态：年龄全在表上（进程重启不丢账），幂等可重入。
 */
export function progressReportTick(deps, now = Date.now()) {
  const { readTable, writeTable, announce, log = () => {}, error = console.error } = deps;
  const table = readTable();
  if (!table) return;
  const lines = table.split('\n');
  const verdicts = [];
  const escalateNos = [];
  let dirty = false;
  let requested = 0;
  let pending = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = parseRow(lines[i]);
    if (!m || !WORKER_NAMES.includes(m[3]) || m[4] !== '进行中') continue;
    const marker = lines[i].match(PROGRESS_MARKER_RE);
    if (marker) {
      const age = now - parseProgressStamp(marker[1], now);
      if (age < PROGRESS_ESCALATE_MS) {
        pending += 1; // 在途（新鲜 = 小工忙时刚刷新过）——防堆叠，不重写
        continue;
      }
      verdicts.push(
        `⏰ #${m[1]}（${m[3]}）连续 2 个周期未例行进度汇报（请求挂了 ${Math.round(age / 60000)} 分钟无回应）→ 交看门狗按卡死处置`,
      );
      lines[i] = stripMarkerFromLine(lines[i]); // 先剥：下拍不再重扫本标记
      escalateNos.push(m[1]);
      dirty = true;
      continue;
    }
    lines[i] = appendMarkerToLine(lines[i], now); // 本周期请求落表，等 worker 捡
    requested += 1;
    dirty = true;
  }
  if (dirty) writeTable(lines.join('\n')); // 一拍最多一次整表写；抛错=半程，下拍重试
  // 改派走 herd 的同一份 reassignTaskRow（它重读表格，吃的正是上面剥完标记的行）
  for (const no of escalateNos) {
    try {
      reassignTaskRow(
        { readTable, writeTable },
        no,
        `例行进度汇报：连续 2 个周期（≥${PROGRESS_ESCALATE_MS / 60000} 分钟）无回应`,
        now,
      );
    } catch (err) {
      error(`[progress] #${no} 改派失败（下拍重试）: ${err?.message ?? err}`);
    }
  }
  if (verdicts.length + requested + pending > 0) {
    log(`[progress] 例行汇报巡检：新请求 ${requested} / 在途 ${pending} / 升级 ${verdicts.length}`);
  }
  if (verdicts.length > 0) {
    // 公告走协作群（async）：fire-and-forget + 接住拒绝——改派已落表，公告失败只记错不回滚
    Promise.resolve()
      .then(() => announce(verdicts.join('\n')))
      .catch((err) => error(`[progress] 公告失败: ${err?.message ?? err}`));
  }
}

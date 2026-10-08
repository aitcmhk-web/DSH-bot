// test-progress-report.mjs — 每 5 分钟例行进度汇报回归测试（任务 #41，独立跑，不依赖 DSH/网络/真表）
//
// 跑法：node test-progress-report.mjs（也兼容 node --test test-progress-report.mjs）
//
// 覆盖（与任务判据一一对应）：
//   ① 常量护栏：固定提示词一字不改 / 升级阈值=2×HERD_CHECK_MS / 忙时刷新门槛=4 分钟 /
//      标记时间戳 round-trip（跨年防御）
//   ② 「进行中」行无标记 → 一拍落请求标记（零公告零升级）
//   ③ 标记在途且新鲜 → 防堆叠：零改写零公告（一行同时只挂一个请求）
//   ④ 标记 ≥10 分钟无回应 → 公告（#号+判据+分钟数）+ 剥标记 + 交看门狗改派翻「待领取」；
//      同拍里新鲜的行不受连坐；再拍零重复公告
//   ⑤ 反向：无进行中行（已发布/待审核/主bot直做）→ 零写表零公告零日志（零注入）
//   ⑥ 失败重试不丢：写表抛错 → 行原样，下一拍重写成功（请求与升级两条路都验）
//   ⑦ worker 侧契约（bot.js CJS 副本）：同文提示词/同值门槛/标记契约/捡标记接线存在
//   ⑧ 接线防回归（静态断言）：src/index.js import+真调用点在 master 门内、onHeartbeat
//      同拍挂载（#34 mgmtRoundTick 仍在=同拍共存不覆盖，派单打回原因点名防覆盖）、
//      dispose 注释随 herd 停

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PROGRESS_REPORT_PROMPT,
  PROGRESS_ESCALATE_MS,
  PROGRESS_RECHECK_MS,
  PROGRESS_MARKER_RE,
  PROGRESS_MARKER_TEXT,
  progressStamp,
  parseProgressStamp,
  appendMarkerToLine,
  stripMarkerFromLine,
  progressReportTick,
} from './src/progress-report.js';
import { HERD_CHECK_MS } from './src/herd.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✅ ${name}`);
};

const MIN = 60 * 1000;

// ── ① 常量护栏（先钉死，后面用例都靠它）────────────────────────────────────
assert.equal(
  PROGRESS_REPORT_PROMPT,
  '例行进度汇报：①本单进展到哪一步 ②下一步干什么 ③需要解决的问题（无也要报无）',
  '固定提示词 = 任务 #41 原文一字不改',
);
assert.equal(PROGRESS_ESCALATE_MS, 2 * HERD_CHECK_MS, '升级阈值 = 2 个巡检周期（同源 HERD_CHECK_MS，别单方面改）');
assert.equal(HERD_CHECK_MS, 5 * MIN, '巡检周期 = 5 分钟（老板令「每 5 分钟」）');
assert.equal(PROGRESS_ESCALATE_MS, 10 * MIN, '连续 2 个周期未报 = 10 分钟');
assert.equal(PROGRESS_RECHECK_MS, 4 * MIN, 'worker 忙时刷新门槛 = 4 分钟（严格小于一个巡检周期）');
assert.match(progressStamp(Date.now()), /^\d{2}-\d{2} \d{2}:\d{2}$/, '标记时间戳形状（与 herd.js localStamp 同形）');
{
  const now = new Date(2026, 9, 8, 22, 30).getTime();
  const s = progressStamp(now);
  assert.equal(PROGRESS_MARKER_RE.test(`前情；${PROGRESS_MARKER_TEXT}(${s}) `), true, '标记契约可被正则识别');
  const back = parseProgressStamp(s, now);
  assert.ok(Math.abs(now - back) < MIN, '时间戳 round-trip 误差 < 1 分钟（分钟精度）');
  const future = parseProgressStamp('01-01 00:00', new Date(2026, 11, 31, 23, 50).getTime());
  assert.ok(future < new Date(2026, 11, 31, 23, 50).getTime(), '跨年防御：未来 1 天外的解析按去年算');
}
{
  const line = '| 28 | 病历工坊 | 002bot | 进行中 | 前情 |';
  const marked = appendMarkerToLine(line, Date.now());
  assert.match(marked, /前情；⏰ 汇报请求\(\d{2}-\d{2} \d{2}:\d{2}\)/, '标记按「；」约定追加');
  assert.equal(stripMarkerFromLine(marked), line, '标记可剥净（round-trip 还原原行）');
}
ok('① 常量护栏：提示词一字不改 + 阈值同源 + 时间戳契约 round-trip');

// ── 桩：内存表格 + 计数公告/日志 ────────────────────────────────────────────
const makeDeps = (tableRef, opts = {}) => {
  const calls = { announce: [], log: [], error: [] };
  let writes = 0;
  return {
    calls,
    deps: {
      readTable: () => tableRef.value,
      writeTable: (t) => {
        if (opts.failFirstWrite && writes === 0) {
          writes += 1;
          throw new Error('写表失败（测试桩）');
        }
        tableRef.value = t;
      },
      announce: async (text) => {
        calls.announce.push(text);
        return { ok: true };
      },
      log: (m) => calls.log.push(m),
      error: (m) => calls.error.push(m),
    },
  };
};
const stampAgo = (min) => progressStamp(Date.now() - min * MIN);
/** 把微任务队列（含 fire-and-forget 公告的 .then/.catch）冲干净：setImmediate 两跳。 */
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};
const row28 = () => `| 28 | 病历工坊 | 002bot | 进行中 | — |`;
const tableOf = (...rows) =>
  ['# 任务表', '> 协作群 chat id: -5334440553', '| # | 任务 | 负责 | 状态 | 验收结论 |', '|---|---|---|---|---|', ...rows].join('\n');

// ── ② 「进行中」行无标记 → 一拍落请求标记 ──────────────────────────────────
{
  const tableRef = { value: tableOf('| 28 | 病历工坊 | 002bot | 进行中 | — |') };
  const { deps, calls } = makeDeps(tableRef);
  progressReportTick(deps);
  assert.match(tableRef.value, /⏰ 汇报请求\(\d{2}-\d{2} \d{2}:\d{2}\)/, '本周期请求标记要落表');
  assert.match(tableRef.value, /\| 28 \| 病历工坊 \| 002bot \| 进行中 \| ⏰ 汇报请求\(/, '结论列落标记（占位「—」按 herd 约定替换）');
  assert.equal(calls.announce.length, 0, '落请求不是异常，零公告');
  assert.equal(calls.log.length, 1, '[progress] 心跳落日志（活性判据）');
  ok('② 进行中行无标记 → 一拍落请求标记（零公告）');
}

// ── ③ 标记在途且新鲜 → 防堆叠：零改写零公告 ────────────────────────────────
{
  const marked = row28().replace('— |', `—；⏰ 汇报请求(${stampAgo(5)}) |`);
  const tableRef = { value: tableOf(marked) };
  const { deps, calls } = makeDeps(tableRef);
  progressReportTick(deps);
  assert.equal(tableRef.value, tableOf(marked), '在途请求不许重写（一行只挂一个请求，防堆叠）');
  assert.equal(calls.announce.length, 0, '新鲜在途 = 小工忙时刚刷新过，零公告');
  ok('③ 在途新鲜标记 → 防堆叠零改写');
}

// ── ④ 标记 ≥10 分钟无回应 → 公告 + 剥标记 + 交看门狗改派 ────────────────────
{
  const stale = row28().replace('— |', `—；⏰ 汇报请求(${stampAgo(11)}) |`);
  const fresh = '| 29 | 分诊台 | 003bot | 进行中 | —；⏰ 汇报请求(' + stampAgo(5) + ') |';
  const tableRef = { value: tableOf(stale, fresh) };
  const { deps, calls } = makeDeps(tableRef);
  progressReportTick(deps);
  await flush();
  assert.equal(calls.announce.length, 1, '连续 2 周期未报必须公告');
  assert.match(calls.announce[0], /#28/, '公告要提哪一行');
  assert.match(calls.announce[0], /002bot/, '公告要提谁');
  assert.match(calls.announce[0], /连续 2 个周期未例行进度汇报/, '公告要有判据');
  assert.match(calls.announce[0], /交看门狗按卡死处置/, '公告要有处置去向');
  assert.match(calls.announce[0], /请求挂了 \d+ 分钟无回应/, '公告要有多久没回应（分钟数取整随秒位浮动，只验形状）');
  const after = tableRef.value;
  assert.match(after, /\| 28 \| 病历工坊 \| 002bot \| 待领取 \|/, '升级行交看门狗翻「待领取」');
  assert.match(after, /看门狗改派/, '结论列注明改派原因（herd reassignTaskRow 同款）');
  assert.doesNotMatch(after.split('\n').find((l) => l.startsWith('| 28 ')), /⏰ 汇报请求/, '升级行标记要剥净（防复领后误判龄）');
  assert.match(after.split('\n').find((l) => l.startsWith('| 29 ')), /\| 29 \|.*\| 进行中 \|/, '新鲜在途的行不受连坐');
  progressReportTick(deps);
  await flush();
  assert.equal(calls.announce.length, 1, '升级后行已离开「进行中」，再拍零重复公告');
  ok('④ 连续 2 周期未报 → 公告+剥标记+交看门狗改派（新鲜行不连坐）');
}

// ── ⑤ 反向：无进行中行 → 零写表零公告零日志 ────────────────────────────────
{
  const tableRef = {
    value: tableOf(
      '| 30 | 已发布的活 | 002bot | 已发布 | ✅ 老板已通过（审核按钮） |',
      '| 31 | 等审核的活 | 003bot | 待审核 | ⏳ 等老板 |',
      '| 32 | 主 bot 直做的活 | 主bot直做 | 进行中 | — |',
    ),
  };
  const before = tableRef.value;
  const { deps, calls } = makeDeps(tableRef);
  progressReportTick(deps);
  assert.equal(tableRef.value, before, '无小工「进行中」行 → 零写表（已发布/待审核/主bot直做全不碰）');
  assert.equal(calls.announce.length, 0, '零公告');
  assert.equal(calls.log.length, 0, '零日志（没在飞就没话说）');
  ok('⑤ 反向：无在飞行/已发布行 → 零注入');
}

// ── ⑥ 失败重试不丢：写表抛错 → 行原样，下一拍重写成功 ──────────────────────
{
  // 请求路
  const tableRef = { value: tableOf(row28()) };
  const { deps, calls } = makeDeps(tableRef, { failFirstWrite: true });
  assert.throws(() => progressReportTick(deps), /写表失败/, '写表抛错要冒出（接线侧 catch 记日志）');
  assert.equal(tableRef.value, tableOf(row28()), '失败 = 行原样（无半程落盘）');
  progressReportTick(deps);
  assert.match(tableRef.value, /⏰ 汇报请求\(/, '下一拍重写成功（重试不丢）');
  // 升级路
  const ref2 = { value: tableOf(row28().replace('— |', `—；⏰ 汇报请求(${stampAgo(12)}) |`)) };
  const d2 = makeDeps(ref2, { failFirstWrite: true });
  assert.throws(() => progressReportTick(d2.deps), /写表失败/, '升级路写表抛错同样冒出');
  assert.match(ref2.value, /⏰ 汇报请求\(/, '标记还在（没剥成=下拍按在途重判，再升级）');
  assert.equal(d2.calls.announce.length, 0, '写表失败那拍公告也不发（整拍原子重试）');
  progressReportTick(d2.deps);
  await flush();
  assert.equal(d2.calls.announce.length, 1, '下一拍升级成功（重试不丢）');
  assert.match(ref2.value, /\| 28 \|.*\| 待领取 \|/, '下一拍改派成功');
  ok('⑥ 失败重试不丢：请求/升级两路都是整拍原子、下拍重试');
}

// ── ⑦ worker 侧契约（bot.js CJS 副本，与 src 互为对照）────────────────────
{
  const bot = readFileSync(new URL('./bot.js', import.meta.url), 'utf8');
  assert.ok(bot.includes(PROGRESS_REPORT_PROMPT), 'bot.js 提示词与 src 同文（一字不改）');
  assert.match(bot, /const PROGRESS_RECHECK_MS = 4 \* 60 \* 1000;/, 'bot.js 忙时刷新门槛同值（4 分钟）');
  assert.ok(bot.includes('⏰ 汇报请求('), 'bot.js 标记契约文本在');
  assert.match(bot, /if \(progressReportPickup\(lines\)\) return;/, '领活轮询里必须真捡标记（import/定义后零调用 = 死代码）');
  assert.match(bot, /submitTurn\(chatId, buildProgressReportBlocks\(\)\)/, '投递走 submitTurn（领活同款通路）');
  assert.match(bot, /cells\[5\] = ` \$\{stripProgressMarkerNote\(cells\[5\]\)\} `;/, '领活占位剥陈旧标记（防复领后误判龄）');
  ok('⑦ worker 侧契约：同文提示词/同值门槛/捡标记接线在领活轮询里');
}

// ── ⑧ 接线防回归（静态断言：import 后必须有真调用点，#34 死因同款）─────────
{
  const src = readFileSync(new URL('./src/index.js', import.meta.url), 'utf8');
  assert.match(src, /import\s*\{\s*progressReportTick\s*\}\s*from\s*'\.\/progress-report\.js'/, 'import 在');
  const iCall = src.indexOf('progressReportTick(');
  assert.ok(iCall > 0, 'progressReportTick 必须有真调用点（#34 死因 = import 后零调用点）');
  assert.ok(
    src.slice(Math.max(0, iCall - 2500), iCall).includes("=== 'master'"),
    '接线必须在 BOT_ROLE=master 角色门内（与 #32 herd / #33 triggers / #34 mgmt 同一门，第 1 条）',
  );
  const iHerd = src.indexOf('createHerdWatchdog({');
  const iHb = src.indexOf('onHeartbeat:', iHerd);
  assert.ok(iHb > 0, '挂在 herd deps 的 onHeartbeat 上（与看门狗同拍，⛔ 不新造定时器）');
  const hbBody = src.slice(iHb, src.indexOf('herd.start()', iHerd));
  assert.match(hbBody, /mgmtRoundTick\(/, '#34 管理回合仍在同一拍上（同拍共存）');
  assert.match(hbBody, /progressReportTick\(/, '#41 汇报巡检挂同一拍（两族拍子并存，互不覆盖）');
  assert.ok(
    src.includes('herd?.stop(); // 看门狗定时器 + .herd.lock + 管理回合拍子 + #41 汇报巡检拍子'),
    'dispose 卸载：汇报巡检随 herd 停（无自有定时器/锁）',
  );
  ok('⑧ 接线防回归：import+调用点齐、master 门内、onHeartbeat 同拍共存、dispose 随 herd 停');
}

console.log(`\nALL PASS — ${passed} 组断言全绿（任务 #41 判据全覆盖）`);

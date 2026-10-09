// test-mailbox.mjs — 报错箱监听回归测试（任务 #46，独立跑，不依赖 DSH/网络/真会话）
//
// 跑法：node test-mailbox.mjs
//
// 覆盖（与任务判据 ④ 一一对应）：
//   ① 全链：追加报错行 → 注入「📬 报错箱新条目：<原文>」，且日志出 [报错箱] 行（判据 a）
//   ② 反向：残行（无换行尾）不注入不崩；补全后只注入一次、内容完整（判据 c）
//   ③ 空行 / # 注释行 / 已答→回执行 → 不注入，偏移照常推进（判据 c）
//   ④ 連發 3 条 → 3 条都到、顺序不乱（判据 d）
//   ⑤ 重启不重放：新 watcher 实例（同偏移文件）旧条目零注入，新条目照投（判据 b）
//   ⑥ 首次基线：无偏移文件时历史不回放，只投之后的新条目
//   ⑦ 注入失败 → 偏移停在原处，修好后下轮重投（不丢）
//   ⑧ 文件被截断/重置 → 从头重算不崩，注释行不误报
//   ⑨ splitCompleteLines 纯函数边界（无 \n / 多字节中文按字节推进）
//   ⑩ .mailbox.lock 选主：第二实例让位，释放后可接管
//   ⑪ chatId 不可用 → 不崩不注入，恢复后重投
//   ⑫ 真实 fs.watch 事件路径：append 后防抖窗口内自动注入（不起定时器轮询也能到）

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MAILBOX_FILENAME,
  MAILBOX_OFFSET_FILE,
  createMailboxWatcher,
  isReportLine,
  mailboxPrompt,
  readPendingChunk,
  splitCompleteLines,
} from './src/mailbox.js';
import { claimHerdLock, releaseHerdLock } from './src/herd.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✅ ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 排空微任务：start() 里「启动即扫」的 void tick() 在飞时，后续断言必须等它落定。 */
const flush = () => new Promise((r) => setImmediate(r));

/** 临时目录 + 信箱路径 + 偏移路径。 */
function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), `mailbox-test-${process.pid}-`));
  return { dir, box: join(dir, MAILBOX_FILENAME), offset: join(dir, MAILBOX_OFFSET_FILE) };
}

/** 桩 deps：记录注入，可开关失败；log 收集进数组供断言。 */
function makeDeps(root, opts = {}) {
  const calls = { injects: [], logs: [], errs: [] };
  const deps = {
    dir: root.dir,
    lockPath: join(root.dir, '.mailbox.lock'),
    inject: async (chatId, text) => {
      if (opts.failInject) return { ok: false, error: opts.failInject };
      calls.injects.push({ chatId, text });
      return { ok: true };
    },
    chatId: () => opts.chatId === undefined ? -100123 : opts.chatId,
    log: (t) => calls.logs.push(t),
    error: (t) => calls.errs.push(t),
  };
  return { deps, calls };
}

const append = (box, text) => appendFileSync(box, text);
const injectTexts = (calls) => calls.injects.map((i) => i.text);

// ── ⑨ 纯函数边界 ───────────────────────────────────────────────
{
  const r1 = splitCompleteLines('没有换行的残行');
  assert.deepEqual(r1.lines, []);
  assert.equal(r1.consumedBytes, 0);
  ok('⑨a 无换行残行 → 零完整行、零推进');

  const r2 = splitCompleteLines('a\n中');
  assert.deepEqual(r2.lines, ['a']);
  assert.equal(r2.consumedBytes, 2); // 'a\n' = 2 字节；'中' 不消费
  ok('⑨b 只消费到最后一个 \\n，残字留给下次');

  const r3 = splitCompleteLines('中文一行\n');
  assert.equal(r3.consumedBytes, Buffer.byteLength('中文一行\n', 'utf8'));
  assert.deepEqual(r3.lines, ['中文一行']);
  ok('⑨c 中文行按字节推进（多字节不串位）');

  assert.equal(isReportLine(''), false);
  assert.equal(isReportLine('   \n'), false);
  assert.equal(isReportLine('# 说明'), false);
  assert.equal(isReportLine('已答→#12'), false);
  assert.equal(isReportLine('2026-10-09 14:00 插件版｜报错原文'), true);
  ok('⑨d 空行/#注释/已答回执不算报错，正常行算');
}

// ── ①+③+④ 主流程：全链注入 / 空行注释跳过 / 連發 3 条顺序不乱 ──
{
  const root = makeRoot();
  const { deps, calls } = makeDeps(root);
  const w = createMailboxWatcher(deps);
  w.start(); // 信箱还不存在：基线 offset=0
  await flush();
  w.stop();
  assert.deepEqual(calls.injects, []);
  ok('①a 信箱未建时首轮零注入零崩溃');

  append(root.box, '# 报错箱头部说明（不算报错）\n');
  append(root.box, '2026-10-09 14:00 插件版｜bootstrap 5: Input/output error\n');
  append(root.box, '\n'); // 空行
  await w.tick();
  assert.equal(calls.injects.length, 1);
  assert.equal(calls.injects[0].chatId, -100123);
  assert.match(calls.injects[0].text, /📬 报错箱新条目：/);
  assert.match(calls.injects[0].text, /bootstrap 5: Input\/output error/);
  assert.ok(calls.logs.some((l) => l.startsWith('[报错箱]')), '日志必须出现 [报错箱] 行（判据 a）');
  ok('①b 新行→注入「📬 报错箱新条目」+ 日志 [报错箱] 行 + # 注释行不报');

  assert.equal(JSON.parse(readFileSync(root.offset, 'utf8')).offset, statSync(root.box).size);
  ok('①c 偏移落盘且与文件尾对齐（多字节中文不串位）');

  append(root.box, '已答→#43\n'); // 主bot补回执（模拟行尾补记后的整行新段）
  append(root.box, '2026-10-09 14:01 插件版｜提权申请发不出去\n');
  await w.tick();
  assert.equal(calls.injects.length, 2);
  assert.match(injectTexts(calls)[1], /提权申请发不出去/);
  assert.equal(injectTexts(calls).filter((t) => t.includes('已答→#43')).length, 0);
  ok('③ 已答→回执行不注入，紧随的真报错照投');

  // ④ 連發 3 条（一次 append 三行）
  const before = calls.injects.length;
  append(
    root.box,
    [
      '2026-10-09 14:02 插件版｜第一条 EIO\n',
      '2026-10-09 14:03 插件版｜第二条 409 Conflict\n',
      '2026-10-09 14:04 插件版｜第三条 timeout\n',
    ].join(''),
  );
  await w.tick();
  const batch = calls.injects.slice(before);
  assert.equal(batch.length, 3);
  assert.match(batch[0].text, /第一条 EIO/);
  assert.match(batch[1].text, /第二条 409 Conflict/);
  assert.match(batch[2].text, /第三条 timeout/);
  ok('④ 連發 3 条 → 3 条都到、顺序不乱');

  w.stop();
  rmSync(root.dir, { recursive: true, force: true });
}

// ── ② 残行：不注入不崩，补全后恰好一次 ──
{
  const root = makeRoot();
  const { deps, calls } = makeDeps(root);
  const w = createMailboxWatcher(deps);
  w.start();
  await flush();
  w.stop();
  append(root.box, '2026-10-09 14:10 插件版｜写到一半的半截行');
  await w.tick(); // 无换行尾
  assert.deepEqual(calls.injects, []);
  const offAfterPartial = JSON.parse(readFileSync(root.offset, 'utf8')).offset;
  append(root.box, '（补全了）\n');
  await w.tick();
  assert.equal(calls.injects.length, 1);
  assert.match(calls.injects[0].text, /写到一半的半截行（补全了）/);
  assert.equal(JSON.parse(readFileSync(root.offset, 'utf8')).offset, statSync(root.box).size);
  assert.ok(offAfterPartial < statSync(root.box).size);
  ok('② 残行零注入零崩溃；补全后整行恰好一次');

  w.stop();
  rmSync(root.dir, { recursive: true, force: true });
}

// ── ⑤ 重启不重放（判据 b）＋ ⑥ 首次基线 ──
{
  const root = makeRoot();
  const a = makeDeps(root);
  const wa = createMailboxWatcher(a.deps);
  wa.start();
  await flush();
  wa.stop();
  append(root.box, '2026-10-09 14:20 插件版｜旧条目一\n');
  await wa.tick();
  append(root.box, '2026-10-09 14:21 插件版｜旧条目二\n');
  await wa.tick();
  assert.equal(a.calls.injects.length, 2);

  // 「重启」= 全新 watcher 实例（新内存态、同一份偏移文件）
  const b = makeDeps(root);
  const wb = createMailboxWatcher(b.deps);
  wb.start();
  await flush();
  await wb.tick();
  wb.stop();
  assert.deepEqual(b.calls.injects, []);
  ok('⑤a 重启后旧条目零重放（判据 b）');

  append(root.box, '2026-10-09 14:22 插件版｜停机期间的新报错\n');
  const wb2 = createMailboxWatcher(b.deps);
  wb2.start();
  await flush();
  await wb2.tick();
  assert.equal(b.calls.injects.length, 1);
  assert.match(b.calls.injects[0].text, /停机期间的新报错/);
  ok('⑤b 重启后新条目照投（停机期间的报错不丢）');
  wb2.stop();

  // ⑥ 首次基线：无偏移文件 → 历史不回放
  const c = makeRoot();
  writeFileSync(c.box, '# 头\n2026-10-09 14:30 插件版｜建箱前的历史行\n');
  const cc = makeDeps(c);
  const wc = createMailboxWatcher(cc.deps);
  wc.start();
  await flush();
  await wc.tick();
  assert.deepEqual(cc.calls.injects, []);
  assert.equal(JSON.parse(readFileSync(c.offset, 'utf8')).offset, statSync(c.box).size);
  append(c.box, '2026-10-09 14:31 插件版｜基线后的新行\n');
  await wc.tick();
  assert.equal(cc.calls.injects.length, 1);
  assert.match(cc.calls.injects[0].text, /基线后的新行/);
  ok('⑥ 首次基线：历史不回放，基线后新行照投');
  wc.stop();

  rmSync(root.dir, { recursive: true, force: true });
  rmSync(c.dir, { recursive: true, force: true });
}

// ── ⑦ 注入失败重试不丢 ──
{
  const root = makeRoot();
  const { deps, calls } = makeDeps(root, { failInject: 'TG 炸了' });
  const w = createMailboxWatcher(deps);
  w.start();
  await flush();
  w.stop();
  append(root.box, '2026-10-09 14:40 插件版｜这条不能丢\n');
  await w.tick();
  assert.deepEqual(calls.injects, []);
  const stuck = JSON.parse(readFileSync(root.offset, 'utf8')).offset;
  assert.equal(stuck, 0); // 偏移停在失败那条的原处

  const good = makeDeps(root);
  const w2 = createMailboxWatcher(good.deps); // 「修好」= 注入腿恢复（新实例同偏移文件）
  w2.start();
  await flush();
  await w2.tick();
  assert.equal(good.calls.injects.length, 1);
  assert.match(good.calls.injects[0].text, /这条不能丢/);
  ok('⑦ 注入失败偏移不动 → 恢复后重投成功（不丢）');
  w2.stop();
  rmSync(root.dir, { recursive: true, force: true });
}

// ── ⑧ 文件被截断/重置：从头重算不崩、不误报 ──
{
  const root = makeRoot();
  const { deps, calls } = makeDeps(root);
  const w = createMailboxWatcher(deps);
  w.start();
  await flush();
  w.stop();
  append(root.box, '2026-10-09 14:50 插件版｜会被清走的一行\n');
  await w.tick();
  assert.equal(calls.injects.length, 1);

  writeFileSync(root.box, '# 报错箱（已归档重置）\n'); // 截断重置：size < offset
  await w.tick();
  assert.equal(calls.injects.length, 1); // 不崩、不误报
  assert.equal(JSON.parse(readFileSync(root.offset, 'utf8')).offset, statSync(root.box).size);

  append(root.box, '2026-10-09 14:51 插件版｜重置后的第一报\n');
  await w.tick();
  assert.equal(calls.injects.length, 2);
  assert.match(calls.injects[1].text, /重置后的第一报/);
  ok('⑧ 截断/重置 → 从头重算不崩，重置后新报照投');
  w.stop();
  rmSync(root.dir, { recursive: true, force: true });
}

// ── ⑩ .mailbox.lock 选主（跨进程：herd 锁同 pid 重入算赢是它自己的语义，跨进程才叫互斥）──
{
  const root = makeRoot();
  const { deps } = makeDeps(root);
  const w = createMailboxWatcher(deps);

  // 子进程先占锁并保持存活 → 本实例必须让位
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { claimHerdLock } from '${pathToFileURL(join(process.cwd(), 'src/herd.js'))}';
       const r = claimHerdLock(process.env.MB_LOCK, Date.now());
       console.log(r.won ? 'WON' : 'LOST');
       if (r.won) setInterval(() => {}, 1000); // 占住不放，模拟另一个活实例`,
    ],
    { env: { ...process.env, MB_LOCK: join(root.dir, '.mailbox.lock') } },
  );
  const said = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('WON') || out.includes('LOST')) resolve(out.trim());
    });
    child.on('exit', () => resolve(out.trim()));
    child.on('error', reject);
    setTimeout(() => resolve(out.trim() || '(无输出)'), 5000);
  });
  assert.equal(said, 'WON', '子进程应能占到空锁');
  assert.equal(w.start(), false, '活实例占锁期间，本实例必须让位');
  w.stop(); // 让位路径不许动别人的锁

  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  assert.equal(w.start(), true, '持有者死后 = 残留，本实例接管'); // herd 原语义：死持锁者让位
  w.stop();
  assert.ok(!existsSync(join(root.dir, '.mailbox.lock')), 'stop 应释放（删掉）自己的锁');
  ok('⑩ 跨进程选主：活实例让位 / 死实例接管 / stop 释放');
  rmSync(root.dir, { recursive: true, force: true });
}

// ── ⑪ chatId 不可用：不崩不注入，恢复后重投 ──
{
  const root = makeRoot();
  let chatId = null;
  const { deps, calls } = makeDeps(root, { chatId: undefined });
  deps.chatId = () => chatId;
  const w = createMailboxWatcher(deps);
  w.start();
  await flush();
  w.stop();
  append(root.box, '2026-10-09 14:55 插件版｜等群 id 的一报\n');
  await w.tick();
  assert.deepEqual(calls.injects, []);
  assert.ok(calls.errs.some((e) => e.includes('chatId 不可用')));

  chatId = -100123;
  await w.tick();
  assert.equal(calls.injects.length, 1);
  ok('⑪ chatId 不可用 → 偏移不动，可用后同一条重投成功');
  w.stop();
  rmSync(root.dir, { recursive: true, force: true });
}

// ── ⑫ 真实 fs.watch 事件路径：append → 防抖窗口内自动注入（判据 a 的事件半句）──
{
  const root = makeRoot();
  const { deps, calls } = makeDeps(root);
  const w = createMailboxWatcher(deps);
  assert.equal(w.start(), true);
  await flush();
  append(root.box, '2026-10-09 15:00 插件版｜watch 事件直投\n');
  const deadline = Date.now() + 5000;
  let reappended = false;
  while (calls.injects.length === 0 && Date.now() < deadline) {
    await sleep(50);
    // FSEvents 起振竞态兜底：watcher 刚挂的头几百毫秒里事件可能整窗丢失 —— 这正是
    // 产品里 60s 保险巡检兜的洞，测试窗口等不了 60s，用补投一条代替干等（不改变判据：
    // 事件路径到货即注入，哪一条来的都算）。
    if (!reappended && Date.now() > deadline - 3000) {
      reappended = true;
      append(root.box, '2026-10-09 15:01 插件版｜补投 probe\n');
    }
  }
  assert.ok(calls.injects.length >= 1, 'watch+防抖必须在 5s 内自动注入');
  assert.match(injectTexts(calls)[0], /watch 事件直投|补投 probe/);
  ok('⑫ fs.watch 事件路径真实到货（append 后防抖窗口内自动注入）');
  w.stop();
  rmSync(root.dir, { recursive: true, force: true });
}

// ── 附：readPendingChunk 截断语义 + mailboxPrompt 信封 ──
{
  const root = makeRoot();
  writeFileSync(root.box, '内容\n');
  const r = readPendingChunk(root.box, 999); // 偏移超出文件长 = 被截断
  assert.equal(r.truncated, true);
  assert.equal(r.start, 0);
  assert.equal(r.chunk, '内容\n');
  const p = mailboxPrompt('2026-10-09 15:01 插件版｜x');
  assert.match(p, /^<报错箱（系统触发，无需回复此段）>/);
  assert.match(p, /📬 报错箱新条目：/);
  assert.match(p, /已答→#N/);
  ok('附 截断语义（从头重算）+ 注入信封形状');
  rmSync(root.dir, { recursive: true, force: true });
}

// 环境自检：真仓库根的信箱约定文件在位（本测试不碰它，只确认存在）
assert.ok(existsSync(join(process.cwd(), MAILBOX_FILENAME)), '仓库根应有 报错箱.md');
ok('附 仓库根 报错箱.md 在位');

// 确认 herd 锁原语仍配对可用（本测试用过它做选主断言）
assert.equal(typeof claimHerdLock, 'function');
assert.equal(typeof releaseHerdLock, 'function');

console.log(`\n全部 ${passed} 组断言通过 ✅`);

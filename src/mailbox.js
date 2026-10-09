/**
 * src/mailbox.js — 报错箱监听（任务 #46，2026-10-09：插件版→主bot 单向报错直通口）。
 *
 * 背景（任务书 #46）：插件版报错只能写任务表结论列，主bot要等轮询/被动消息才看到，
 * 不及时【已验证：#43 插件版 08:3x 落表、主bot 08:4x 才答】。老板令「给插件 bot 开一个
 * 直通口子，他那边发现错误就可以单向报信给你，你就可以及时处理」。
 *
 * 通路（单向，只进不出）：插件版往 <bot目录>/报错箱.md 末尾**追加**一行
 * （格式约定见该文件头部注释）：`YYYY-MM-DD HH:MM 插件版｜<错误原文原样，不截断>`。
 * 本模块见新行 → inject() 把「📬 报错箱新条目：<原文>」注入主bot会话 —— 走 #33
 * taskTriggers 同款腿（enqueue + promptFromHub；TG 平台不向 bot 投递 bot 的发言，
 * 光落文件叫不醒会话，注入才是叫醒腿）。主bot的答复**不回信箱**：写任务表对应行
 * 结论列；处理完在该报错行**行尾**补「已答→#N」。
 *
 * 机制（任务书 ② 原判据：fs.watch + 防抖 + 按字节偏移增量读，偏移落盘防重启重放）：
 *   - fs.watch(目录) + 300ms 防抖：报错箱.md 可能还不存在（插件版第一次报错才建），
 *     所以监听**父目录**、回调里按文件名过滤 —— 创建 / 追加 / sed -i 原子替换全逃不掉，
 *     不需要「文件没了再重挂」的逻辑。
 *   - 按字节偏移增量读：只读「上次消费位置 → 现文件尾」，并且**只消费到最后一个 \n** ——
 *     半截行（写到一半 / 无换行尾）不消费不注入，等它补全再算（任务判据 c）。
 *     UTF-8 的 \n 不可能出现在多字节序列中间，按 \n 切在字节层面天然安全；
 *     偏移推进按 Buffer.byteLength 算，中文报错不会算错位。
 *   - 偏移持久化在 <bot目录>/.mailbox.offset.json（tmp + rename 原子写）→ 进程重启
 *     不重放旧条目（任务判据 b）。⚠️ 刻意**不**落 bot.js 的 .state.json：那边 saveState()
 *     是整体重写，两个写方各写各的会互相抹掉（src/index.js:466 在案教训）；
 *     本文件由本模块独占读写，别处 ⛔ 不许碰。
 *   - 首次运行（还没有偏移文件）：基线 = 现文件大小，**历史不回放** —— 报错箱本体就是
 *     留痕，注入只是叫醒腿；例外：信箱是本实例启动**之后**才建出来的（start 时还没有），
 *     视里面的内容为新报错、从 0 读 —— 否则主bot先起、插件版后建箱，第一条报错会被
 *     当历史吞掉。之后每成功注入一条才推进一格：注入失败偏移停在失败那条，
 *     下次事件 / 保险巡检 / 重启都从那条重投（至少一次语义，顺序不乱：逐条 await、
 *     按文件顺序投递）。
 *   - 60s 保险巡检：fs.watch 偶发漏报（macOS 换 inode、FSEvents 抖动）时兜底，
 *     与 watch 共用同一个 tick（running 防重入，漏不掉也叠不了）。
 *   - 只注入「非空、非 # 注释、非主bot自己补的『已答→』回执」的完整行；空行照过
 *     （偏移推进、不注入）。
 *
 * 角色门在 src/index.js 接线处：只有 BOT_ROLE=master 的实例 start（同 #32/#33 一字同款
 * 门口径 —— 审核实例 / worker 实例不挂，报错只叫醒主bot一个人的会话）；
 * .mailbox.lock 选主兜底双 master 误配（复用 herd 的锁实现，同 #33，⛔ 不复制第二份锁逻辑）。
 *
 * 依赖全部注入（inject / chatId / 日志），测试不起真进程、不碰真会话（test-mailbox.mjs）。
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { claimHerdLock, releaseHerdLock } from './herd.js';

/** 信箱文件名（放 bot 目录 = DSH_BOT_DIR ?? 任务表同目录）。 */
export const MAILBOX_FILENAME = '报错箱.md';
/** 偏移落盘文件（本模块独占；⚠️ 不是 bot.js 的 .state.json，见头注释）。 */
export const MAILBOX_OFFSET_FILE = '.mailbox.offset.json';
/** watch 事件防抖：连发事件合并成一次读（任务判据 d：連發 3 条一次收齐）。 */
export const MAILBOX_DEBOUNCE_MS = 300;
/** 保险巡检节奏：watch 漏报兜底（只在事件没来时起作用，平时零成本路径 = stat 差异）。 */
export const MAILBOX_SWEEP_MS = 60 * 1000;
/** 单次最多读多少字节：信箱暴涨时不一口吞（剩余的下一轮继续，偏移逐步推进）。 */
export const MAILBOX_MAX_READ_BYTES = 512 * 1024;

/**
 * 把「从偏移处读到的文本」拆成完整行（任务判据 c 的纯函数核心）：
 * 只消费到最后一个 \n 为止，之后的残行留给下次（等它写全）。
 * → { lines: string[], consumedBytes: number }；一个完整行都没有 → { [], 0 }。
 */
export function splitCompleteLines(text) {
  const cut = text.lastIndexOf('\n');
  if (cut === -1) return { lines: [], consumedBytes: 0 };
  const complete = text.slice(0, cut + 1);
  const pieces = complete.split('\n');
  pieces.pop(); // 最后一个 \n 之后那个空串不是行
  return { lines: pieces, consumedBytes: Buffer.byteLength(complete, 'utf8') };
}

/** 该行算不算要注入的报错：非空、非 # 注释、非主bot补的「已答→」回执。 */
export function isReportLine(line) {
  const t = String(line).trim();
  if (!t) return false; // 空行：过，不注入
  if (t.startsWith('#')) return false; // 报错箱.md 头部说明/注释
  if (t.startsWith('已答→')) return false; // 主bot处理完补在行尾的回执残段
  return true;
}

/** 注入文本（任务书原话「📬 报错箱新条目：<原文>」+ 一句处理约定，#33 验收 prompt 同款信封）。 */
export function mailboxPrompt(line) {
  return [
    '<报错箱（系统触发，无需回复此段）>',
    '📬 报错箱新条目：',
    line,
    '（插件版直通报错。答复写任务表对应行结论列 @插件版；处理完在 报错箱.md 该行行尾补「已答→#N」；格式约定见 报错箱.md 头部注释）',
    '</报错箱（系统触发，无需回复此段）>',
  ].join('\n');
}

/** 偏移落盘（tmp + rename 原子写：写一半崩了也不会留下坏 JSON 导致重放）。 */
function persistOffset(offsetPath, offset) {
  const tmp = `${offsetPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ offset, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  renameSync(tmp, offsetPath);
}

/** 读偏移：文件缺失 / JSON 坏 / 值不像偏移 → null（调用方走首次基线，不重放历史）。 */
export function loadOffset(offsetPath) {
  try {
    const saved = JSON.parse(readFileSync(offsetPath, 'utf8'));
    return Number.isInteger(saved?.offset) && saved.offset >= 0 ? saved.offset : null;
  } catch {
    return null;
  }
}

/**
 * 读「偏移 → 文件尾」这段字节（同步小读：信箱一行一条，量小）。
 * 文件比记录的偏移短（被截断/重置）→ 从 0 重算：旧内容已不在，现文件内容就是全部。
 */
export function readPendingChunk(mailboxPath, offset) {
  const fd = openSync(mailboxPath, 'r');
  try {
    const size = fstatSync(fd).size;
    const truncated = size < offset;
    const start = truncated ? 0 : offset;
    const want = Math.min(size - start, MAILBOX_MAX_READ_BYTES);
    if (want <= 0) return { chunk: '', start, size, truncated };
    const buf = Buffer.alloc(want);
    readSync(fd, buf, 0, want, start);
    return { chunk: buf.toString('utf8'), start, size, truncated };
  } finally {
    closeSync(fd);
  }
}

/**
 * 一轮扫描：基线（首跑）→ 读新段 → 逐条按顺序注入，注入成功才推进并落偏移。
 * 任何一步失败都停在原地等重试（不丢条目）；文件没了 → 偏移归零等它再被建出来。
 */
export async function mailboxTick(deps, state) {
  const { mailboxPath, offsetPath, inject, chatId, log = () => {}, error = console.error } = deps;

  if (!existsSync(mailboxPath)) {
    if (state.baselined && state.offset !== 0) {
      state.offset = 0;
      persistOffset(offsetPath, 0);
      log('[报错箱] 报错箱.md 不在了 —— 偏移归零，等它再被建出来');
    }
    return;
  }

  if (!state.baselined) {
    state.baselined = true;
    const saved = loadOffset(offsetPath);
    if (saved === null) {
      const size = statSync(mailboxPath).size;
      // 首跑无偏移文件的基线，分两案（ⓘ 历史不回放，但别吞「看着它出生」的新报错）：
      //  · 文件在 start() 之前就存在 = 历史 → 基线到 EOF 不回放（报错箱本体即留痕）；
      //  · 文件是本实例 start() 之后才出生的（start 时还没有）→ 里面全是新报错，从 0 读。
      //    （没有这层区分，主bot先起、插件版后建箱的第一条报错会被当历史吞掉。）
      const fromZero = state.existedAtStart === false;
      state.offset = fromZero ? 0 : size;
      persistOffset(offsetPath, state.offset);
      log(
        `[报错箱] 首次运行基线 offset=${state.offset}（${
          fromZero ? '信箱是本实例启动后才建，内容按新报错处理' : '历史不回放，报错箱本体即留痕'
        }）`,
      );
      if (!fromZero) return;
    } else {
      state.offset = saved;
    }
  }

  for (;;) {
    let res;
    try {
      res = readPendingChunk(mailboxPath, state.offset);
    } catch (err) {
      error(`[报错箱] 读取失败（${err?.message ?? err}）—— 偏移不动，下轮重试`);
      return;
    }
    if (res.truncated) log(`[报错箱] 文件比记录的偏移短（被截断/重置）—— 从头重算`);
    const { lines, consumedBytes } = splitCompleteLines(res.chunk);
    if (consumedBytes === 0) return; // 只有残行/无新增：不推进不注入（残行等写全）
    if (res.truncated) {
      state.offset = res.start; // 先把「从头重算」这个事实落盘
      persistOffset(offsetPath, state.offset);
    }

    let advanced = 0;
    let failed = false;
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 = 行尾 \n
      if (isReportLine(line)) {
        const cid = chatId();
        if (!Number.isInteger(cid)) {
          error('[报错箱] 注入目标 chatId 不可用（群 id / owner 都还没有）—— 偏移停在原处，下轮重试');
          failed = true;
          break;
        }
        const r = await Promise.resolve()
          .then(() => inject(cid, mailboxPrompt(line)))
          .catch((err) => ({ ok: false, error: err?.message ?? String(err) }));
        if (!r?.ok) {
          error(`[报错箱] 注入失败（${r?.error ?? '?'}）—— 偏移停在原处，下次事件/巡检/重启重投`);
          failed = true;
          break;
        }
        log(`[报错箱] 已注入新条目（offset ${state.offset} → ${res.start + advanced + lineBytes}）`);
      }
      advanced += lineBytes;
      state.offset = res.start + advanced;
      persistOffset(offsetPath, state.offset);
    }
    if (failed || advanced < consumedBytes) return; // 失败/读顶到上限：剩下交给下一轮
  }
}

// ── 接线工厂：index.js 用它挂 watch + 保险巡检（triggers 工厂同款形状）─────────
/** deps = { dir, lockPath, inject, chatId, log, error }
 *  返回 { start, stop, tick, mailboxPath, offsetPath, state }；start 选主失败 = 别的实例在跑。 */
export function createMailboxWatcher(deps) {
  const mailboxPath = join(deps.dir, MAILBOX_FILENAME);
  const offsetPath = join(deps.dir, MAILBOX_OFFSET_FILE);
  const state = { offset: 0, baselined: false, existedAtStart: undefined };
  let watcher = null;
  let sweep = null;
  let debounce = null;
  let running = false; // 防重入：tick 内有 await（注入），间隔内没跑完不许叠
  let dirty = false; // 跑的时候又来事件：跑完补一轮

  async function tick() {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    try {
      await mailboxTick({ ...deps, mailboxPath, offsetPath }, state);
    } catch (err) {
      deps.error?.(`[报错箱] 轮询失败: ${err?.stack ?? err?.message}`);
    } finally {
      running = false;
      if (dirty) {
        dirty = false;
        void tick();
      }
    }
  }

  function schedule() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void tick();
    }, MAILBOX_DEBOUNCE_MS);
    if (debounce.unref) debounce.unref();
  }

  function onWatchEvent(_eventType, filename) {
    if (filename != null) {
      const name = typeof filename === 'string' ? filename : filename.toString('utf8');
      if (name !== MAILBOX_FILENAME) return; // 只关心信箱本体（bot.log 等高频邻居不过闸）
    }
    schedule(); // filename 拿不到的平台：宁可多读一轮（空读零成本），不漏
  }

  function start() {
    let c;
    try {
      c = claimHerdLock(deps.lockPath, Date.now());
    } catch (err) {
      deps.error?.(`[报错箱] 选主失败（${err?.message}）—— 本实例不开监听`);
      return false;
    }
    if (!c.won) {
      if (c.error) deps.error?.(`[报错箱] .mailbox.lock 不可用（${c.error}）—— 本实例不开监听`);
      else deps.log?.(`[报错箱] 已由别的实例看护（.mailbox.lock 持有者 pid ${c.holder ?? '?'}），本实例不开`);
      return false;
    }
    if (c.tookOver) deps.log?.(`[报错箱] .mailbox.lock 是失联残留（pid ${c.holder ?? '?'}），本实例接管`);
    state.existedAtStart = existsSync(mailboxPath); // 基线用：启动时信箱在不在（见 mailboxTick 基线两案）
    void tick(); // 启动即扫一轮（含首次基线 / 重启后补投停机期间的新条目）
    try {
      watcher = watch(deps.dir, { persistent: false }, onWatchEvent);
      watcher.on('error', (err) => deps.error?.(`[报错箱] watch 异常（${err?.message}）—— 保险巡检兜底`));
    } catch (err) {
      deps.error?.(`[报错箱] fs.watch 挂不上（${err?.message}）—— 只剩 ${MAILBOX_SWEEP_MS / 1000}s 保险巡检`);
    }
    sweep = setInterval(() => void tick(), MAILBOX_SWEEP_MS);
    if (sweep.unref) sweep.unref();
    deps.log?.(
      `[报错箱] 监听已挂（${mailboxPath}，防抖 ${MAILBOX_DEBOUNCE_MS}ms + ${MAILBOX_SWEEP_MS / 1000}s 保险巡检，pid ${process.pid}）`,
    );
    return true;
  }

  function stop() {
    if (debounce) clearTimeout(debounce);
    debounce = null;
    if (sweep) clearInterval(sweep);
    sweep = null;
    try {
      watcher?.close();
    } catch {
      /* watch 已挂也不连累卸载 */
    }
    watcher = null;
    try {
      releaseHerdLock(deps.lockPath);
    } catch {
      /* 锁清理失败不连累卸载 */
    }
  }

  return { start, stop, tick, mailboxPath, offsetPath, state };
}

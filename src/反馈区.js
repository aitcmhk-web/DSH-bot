/**
 * src/反馈区.js — 反馈区看门狗（插件内版）：盯几个目录，内容一变就注入本会话。
 *
 * 为什么要有它：两边的「反馈区」靠人肉轮询（会话里 `sleep 1800` 的循环，有变化就
 * exit 叫醒会话）。那种循环一退出就没人重挂，2026-10-26 实际哑过一个多小时。
 * 插件本来就有 5 分钟一拍（herd / triggers / mailbox），本模块挂同一节拍，
 * 变化直接走 inject（enqueue + promptFromHub）——TG 不投 bot 自己的发言，注入才是叫醒腿。
 *
 * 机制：
 *   - 每 intervalMs（默认 5 分钟）算一次每个目录的指纹：遍历文件（跳过 .备份 / 原始 /
 *     node_modules；原始记录每来一条信就变，会把会话刷爆），每个文件取「相对路径 + 字节数 +
 *     sha256 前 16 位」，排序后整体再 sha256。目录小（几十个文件、每个几十 KB），一轮几毫秒。
 *   - 与 statePath 里记的上次指纹比：有目录变了 → 注入一句「📣 <名称> 有更新」，
 *     并把新指纹写回（tmp + rename 原子写，别处不许碰这个文件）。
 *   - 首次运行（没有状态文件）= 只记基线、不注入（避免一启动就把历史当新变化）。
 *   - 注入失败 → 不推进状态，下一拍重投（至少一次语义）。
 *   - 目录不存在 → 跳过并记一行日志，⛔ 不抛（别因为一个目录没挂把整拍打死）。
 *
 * 角色门：本模块不认 BOT_ROLE —— 谁配了 `反馈区盯` 谁就开（审核实例也可以要）。
 * .feedback.lock 选主兜底双实例误配（复用 herd 的锁实现，不复制第二份锁逻辑）。
 *
 * 依赖全部注入（chatId / inject / 日志），测试不起真进程、不碰真会话（test-反馈区.mjs）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { claimHerdLock, releaseHerdLock } from './herd.js';

const 跳过目录 = (路径) => 路径.includes('/.备份') || 路径.includes('/原始') || 路径.includes('/node_modules');

/**
 * 算一个目录的指纹。入参：根目录、只认名单（空＝全收，只比文件名）。
 * 出参：{ 指纹, 文件数 }。约束：只认名单非空时，名单外的文件不进指纹。
 */
function 目录指纹(根, 只认 = []) {
  let 条目 = 0;
  const 行 = [];
  const 走 = (目录) => {
    for (const 名 of readdirSync(目录)) {
      const 全 = join(目录, 名);
      if (跳过目录(全)) continue;
      let 态;
      try {
        态 = statSync(全);
      } catch {
        continue;
      }
      if (态.isDirectory()) {
        走(全);
        continue;
      }
      if (!态.isFile()) continue;
      if (只认.length && !只认.includes(名)) continue;
      let 内容;
      try {
        内容 = readFileSync(全);
      } catch {
        continue;
      }
      条目 += 1;
      行.push(`${全.slice(根.length)}\t${内容.length}\t${createHash('sha256').update(内容).digest('hex').slice(0, 16)}`);
    }
  };
  走(根);
  行.sort();
  return { 指纹: createHash('sha256').update(行.join('\n')).digest('hex').slice(0, 16), 文件数: 条目 };
}

/**
 * 建一个反馈区看门狗。
 * deps = { dirs:[{名称,目录}], statePath, lockPath, intervalMs?, chatId, inject, log?, error? }
 * 返回 { start, stop, tick }；start 选主失败 = 别的实例在跑，本实例不开。
 */
export function createFeedbackWatch(deps) {
  const {
    dirs = [], statePath, lockPath, intervalMs = 5 * 60 * 1000,
    chatId, inject, log = () => {}, error = console.error,
  } = deps;
  let timer = null;
  let running = false;

  const 读状态 = () => {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8')) ?? {};
    } catch {
      return null; // 没有 / 坏了都当第一次
    }
  };
  const 写状态 = (态) => {
    const 临时 = `${statePath}.tmp`;
    writeFileSync(临时, JSON.stringify(态));
    renameSync(临时, statePath);
  };

  async function tick() {
    if (running) return;
    running = true;
    try {
      const 上次 = 读状态();
      const 现 = {};
      const 变了 = [];
      for (const { 名称, 目录, 只认 } of dirs) {
        if (!existsSync(目录)) {
          log(`[反馈区] 「${名称}」目录不在：${目录}（跳过）`);
          continue;
        }
        const { 指纹, 文件数 } = 目录指纹(目录, Array.isArray(只认) ? 只认 : []);
        现[名称] = { 指纹, 文件数, 时间: new Date().toISOString() };
        if (!上次) continue; // 第一次：只记基线
        if (上次[名称]?.指纹 !== 指纹) 变了.push({ 名称, 目录, 文件数 });
      }
      if (!上次) {
        写状态(现);
        log(`[反馈区] 基线已记（${dirs.length} 个目录）`);
        return;
      }
      if (!变了.length) return;
      const 话 = `📣 反馈区有更新：${变了.map((v) => `「${v.名称}」(${v.文件数} 个文件)`).join('、')}。去看一眼：${变了[0].目录}`;
      await inject(chatId(), 话);
      写状态(现);
      log(`[反馈区] 已注入：${变了.map((v) => v.名称).join('、')}`);
    } catch (err) {
      error(`[反馈区] 巡检失败: ${err?.stack ?? err?.message}`);
    } finally {
      running = false;
    }
  }

  function start() {
    if (!dirs.length) return false;
    let 锁;
    try {
      锁 = claimHerdLock(lockPath, Date.now());
    } catch (err) {
      error(`[反馈区] 选主失败（${err?.message}）—— 本实例不开`);
      return false;
    }
    if (!锁.won) {
      log(`[反馈区] 已由别的实例看护（pid ${锁.holder ?? '?'}），本实例不开`);
      return false;
    }
    log(`[反馈区] 本实例接手（${dirs.map((d) => d.名称).join('、')}，每 ${intervalMs / 60000} 分钟）`);
    void tick();
    timer = setInterval(tick, intervalMs);
    if (timer.unref) timer.unref();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    try {
      releaseHerdLock(lockPath);
    } catch {
      /* 锁清理失败不连累卸载 */
    }
  }

  return { start, stop, tick };
}

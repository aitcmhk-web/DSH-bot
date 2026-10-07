/**
 * 小工注入瘦身 · AGENTS 精简切片生成器（任务表 #35，2026-10-08）。
 *
 * 背景：小工（BOT_ROLE=worker）每个任务新会话都要背**全量** AGENTS.md，
 * 其中门五微信/门六TG/门七模型配置/门八插件升级/门九交付脚本是主 bot 专属，
 * 小工零使用（老板 2026-10-08 定：「好多小工根本用不上」）。
 *
 * 机制（照抄 LITE.md 先例：dsh.js 设 DSH_LITE_INSTRUCTIONS + profile 门控）：
 *   - worker 启动时从这里**结构化裁剪**权威源 AGENTS.md（只取「# 门五、」之前
 *     的部分：门一~四 + 第 29/30 条全在门五前）→ 写出 AGENTS.worker.md；
 *   - 同时设 DSH_WORKER_INSTRUCTIONS=1，配合四个小工 profile 里
 *     agent-instructions 的 !!js 门控，让小工宿主改挂 AGENTS.worker.md
 *     （门控部署车 = 仓库根 启用小工精简指令.command，由总控执行）；
 *   - 主 bot（master）零动作：不写文件、不设 env、不碰任何注入源。
 *
 * 单源保证（AGENTS 第 1 条）：切片每次 worker 启动都从 AGENTS.md 现裁，
 * AGENTS.md 一改小工下次启动自动跟上；本文件**不保存**任何规矩正文。
 * 失败一律降级：裁不出来 → 不写文件、不设 env，小工回退全量 AGENTS.md，
 * 绝不让小工变成「没有任何指令」。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 结构标记：第一个以它开头的行之前 = 小工要的部分（⛔ 别用别的切法）。 */
export const WORKER_SLICE_MARKER = '# 门五、';

/** 生成的切片文件名（必须放在工作区根，宿主插件按 cwd 同目录候选解析）。 */
export const WORKER_INSTRUCTIONS_FILE = 'AGENTS.worker.md';

/**
 * 纯函数：从 AGENTS.md 全文裁出「# 门五、」之前的部分。
 *
 * @param {string} agentsRaw AGENTS.md 全文
 * @returns {{ ok: true, slice: string } | { ok: false, reason: string }}
 */
export function buildWorkerInstructionSlice(agentsRaw) {
  const raw = String(agentsRaw ?? '');
  if (!raw) return { ok: false, reason: 'AGENTS.md 为空' };
  // 行首匹配：必须吃掉「行首的 # 门五、」，防止正文里恰好出现这个短语被误切。
  const cut = raw.indexOf(`\n${WORKER_SLICE_MARKER}`);
  if (cut < 0) return { ok: false, reason: `找不到结构标记「${WORKER_SLICE_MARKER}」所在行` };
  const slice = raw.slice(0, cut).trimEnd();
  if (!slice) return { ok: false, reason: '切出结果为空' };
  return { ok: true, slice };
}

/** 切片文件顶部横幅：防有人把它当第二权威源手改（权威源只有 AGENTS.md）。 */
const BANNER =
  `> ⚠️ 本文件由 bot.js 每次小工启动时从 AGENTS.md 自动裁剪生成（门五及之后的部分不在此文件），` +
  '勿手改、勿 commit；权威源 = AGENTS.md。\n\n';

/**
 * 入口：按角色同步小工精简指令（bot.js 在 BOT_ROLE 算好后调用一次）。
 *
 * @param {{ root: string, role: string, log?: (...a: any[]) => void, logErr?: (...a: any[]) => void }} opts
 * @returns {{ generated: boolean, sliceBytes?: number, fullBytes?: number, envSet: boolean }}
 */
export function syncWorkerInstructions({ root, role, log = () => {}, logErr = () => {} }) {
  delete process.env.DSH_WORKER_INSTRUCTIONS; // 先清残留，master/失败态绝不带旧值
  if (role !== 'worker') return { generated: false, envSet: false };
  try {
    const agentsPath = join(root, 'AGENTS.md');
    if (!existsSync(agentsPath)) throw new Error(`找不到 ${agentsPath}`);
    const full = readFileSync(agentsPath, 'utf-8');
    const cut = buildWorkerInstructionSlice(full);
    if (!cut.ok) throw new Error(cut.reason);
    const outFile = join(root, WORKER_INSTRUCTIONS_FILE);
    writeFileSync(outFile, BANNER + cut.slice + '\n');
    process.env.DSH_WORKER_INSTRUCTIONS = '1';
    const fullBytes = Buffer.byteLength(full);
    const sliceBytes = Buffer.byteLength(cut.slice);
    log(`[bot] 小工精简指令已生成 ${WORKER_INSTRUCTIONS_FILE}（${sliceBytes}B / 全量 ${fullBytes}B）并设 DSH_WORKER_INSTRUCTIONS=1`);
    return { generated: true, sliceBytes, fullBytes, envSet: true };
  } catch (err) {
    // 降级：不写文件、不设 env → 宿主按原候选表达式照挂全量 AGENTS.md。
    // （候选表只能是 ["AGENTS.worker.md"] 单候选：宿主插件把**所有存在的候选**
    //   全部注入，若回退列表里再带上 AGENTS.md，两份会一起进 prompt 反而更胖。
    //   「文件在进程运行中途被删」属非正常路径，进程一重启本模块即重建。）
    logErr(`[bot] 小工精简指令生成失败(已忽略,小工回退全量 AGENTS.md): ${err.message}`);
    return { generated: false, envSet: false };
  }
}

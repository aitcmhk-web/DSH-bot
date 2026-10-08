/**
 * src/mgmt-round.js — 例行管理回合（任务 #34，2026-10-08）。
 *
 * 老板原话：「靠消息唤醒还是没有发挥管理者的主观能动性。」主 bot 只有被消息
 * 唤醒才干活；本模块让插件每 30 分钟主动给 agent 开一回合「管理回合」，
 * 让它自己读任务表、验收、发版、派活、推动卡住的事，收尾向协作群播报。
 *
 * 实现（⛔ 不新造轮询，与 #32 看门狗定时器同拍复用 —— 第 1 条）：
 *   - 本文件只有**纯逻辑**（无定时器）：tick 由 src/herd.js 的看门狗定时器
 *     每 5 分钟一拍地带起来（onHeartbeat），这里自己判「距上次 ≥30 分钟」。
 *   - 投递照 runtime.js:279 的现成 followup 排队语义：runtime.prompt() 排队
 *     立即返回 → runtime.waitForTurn() 等回合结束（自带 30 分钟超时兜底，
 *     事件收不到也不会永久堵死 busy 标志）。
 *   - 防堆叠：followup 是排队语义，上一回合没结束再排一条只会越排越多；
 *     busy 标志在 fire 前置位、finally 复位（失败也复位，一次失败不许永久卡死）。
 *   - 心跳：触发 / 忙跳过 / 结束 三个节点都落 [mgmt-round] 日志（判据要求
 *     主 bot 日志可见本模块的活性）。
 *
 * 启用范围：接线方（src/index.js）只在 BOT_ROLE=master 的实例传 fire ——
 *   审核员实例（未设 BOT_ROLE）与小工实例（worker）天然不触发。
 * 依赖全注入（fire/log/error），测试不用起真 runtime、不碰真表。
 */

/** 管理回合节奏（常量可调）。与看门狗 5 分钟一拍解耦：这里判距，不数拍子。 */
export const MGMT_ROUND_MS = 30 * 60 * 1000;

/** 管理回合的固定提示词（任务 #34 原文一字不改；老板定的管理动作清单）。 */
export const MGMT_ROUND_PROMPT =
  '例行管理回合：①读任务表——查待验收/待审核/打回/进行中各行与四小工日志新鲜度；' +
  '②该验收当场验收、该发版当场发版、该派活当场派、卡住推动；' +
  '③收尾给协作群一句话（做了什么/发现什么/无异常也要说）。';

/** 管理回合专用会话标识：独立会话，不与任何真实 chat 的历史互相污染。 */
export const MGMT_CHAT_KEY = 'mgmt-round';

/** 跨 tick 保留的状态（busy 去重标志 + 上次触发时刻）。 */
export function makeMgmtState() {
  return { busy: false, lastFiredAt: 0 };
}

/**
 * 一拍判定：到点且空闲才触发。返回 true = 本拍真的触发了一回合。
 *
 * deps = { fire, log, error }：
 *   - fire(): () => Promise —— 投递一回合（排队 + 等结束），拒绝 = 本回合失败；
 *     tick 只负责 busy 的置/清与日志，不 await fire（回合跑几十分钟也不堵拍子）。
 *   - log/error：[mgmt-round] 心跳落点。
 */
export function mgmtRoundTick(state, deps, now = Date.now()) {
  const { fire, log = () => {}, error = console.error } = deps;

  // 未到拍（<30 分钟）：静默跳过。每 5 分钟一拍都进这里，写日志纯属刷屏。
  if (now - state.lastFiredAt < MGMT_ROUND_MS) return false;

  // 防堆叠：上一回合还没结束，本轮跳过（followup 排队语义下再排只会堆积）。
  if (state.busy) {
    log('[mgmt-round] 上一管理回合未结束，本轮跳过（防堆叠）');
    return false;
  }

  state.busy = true;
  state.lastFiredAt = now;
  log(`[mgmt-round] 管理回合触发（每 ${MGMT_ROUND_MS / 60000} 分钟一拍）`);
  void Promise.resolve()
    .then(() => fire())
    .catch((err) => error(`[mgmt-round] 管理回合失败: ${err?.message ?? err}`))
    .finally(() => {
      state.busy = false; // 成功失败都解锁 —— 一次失败不许把管理回合永久卡死
    });
  return true;
}

/**
 * 真投递：给管理回合会话排一条固定提示词，然后等这一轮结束。
 * 返回 Promise：resolve = 回合正常结束；reject = 排队失败 / 回合报错 / 超时。
 * 调用方（index.js）注入 runtime；这里不 import，保持纯逻辑可测。
 */
export async function fireMgmtRound(runtime, { log = () => {}, error = console.error } = {}, chatKey = MGMT_CHAT_KEY) {
  const startedAt = Date.now();
  const queued = await runtime.prompt(chatKey, MGMT_ROUND_PROMPT);
  if (!queued?.ok) throw new Error(`排队失败: ${queued?.error ?? 'runtime 无返回'}`);
  log(`[mgmt-round] 提示词已排队（会话 ${chatKey}，messageId ${queued.messageId ?? '无'}）`);
  const done = await runtime.waitForTurn(chatKey);
  if (!done?.ok) throw new Error(`回合未完成: ${done?.error ?? '未知'}`);
  log(`[mgmt-round] 管理回合结束（耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）`);
  return done;
}

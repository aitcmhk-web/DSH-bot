/**
 * 最高指令（HARD-RULES.md）注入器 —— 挂在 `agent/pre-step` 上，按「步」计数。
 *
 * 用户 2026-10-03 定：不是「开头读过一次就算」，而是「每干若干步就再出现一次」，
 * 否则干着干着就忘了。频率 = 第 1 步 + 之后每 N 步（见 HARD_RULES_EVERY_N）。
 *
 * 为什么从 `tools/post-execute` 换到 `agent/pre-step`：
 *   前者是**工具已经跑完**才触发 —— 第一次动手本身不受它约束，注入只对后面几步生效，
 *   等于「第一次来不及阻止」。`agent/pre-step` 是**模型这一步的请求发出之前**触发
 *   （dsh-agent-loop/lib/index.js:911 的 `dispatch.waterfall("agent/pre-step", ...)`），
 *   模型在决定第一次动手之前就能看到规则。
 *
 * 为什么是 waterfall 链上的「中间件」而不是直接返回：
 *   `waterfall` 里监听者**必须调用 `next()`** 才会走到内层（含宿主默认行为，
 *   比如 runtimeContext 的 context 注入）—— 不调 next() 就否决了整条链。
 *   所以本 handler 先 `await next()` 拿到宿主决定，再往 `decision.messages` 里插一段。
 *   形状照抄官方 `dsh-agent-instructions` 的同名前缀处理器（ctx.on("agent/pre-step", ...)）。
 *
 * 两个必须守住的坑：
 *   ① 空转步：turn 循环里 `phase.step === 0 && decision.messages.length === 0` 时
 *      turn 直接结束。要在这种「没有任何待处理消息」的步里塞消息，会把本该收尾的
 *      turn 强行顶出一步（模型自己找话说）。→ claimed 为空时不记账、不注入。
 *   ② 双挂载：与 `tools/post-execute` 一样，`ctx` / `ctx.root` 两处挂载会被各触发
 *      一次（2026-10-02 实测：注入曾落在 1,6,11,16… 次）。→ 按 `agent:turn:step`
 *      去重，保证「一步只计 1、只注 1」。
 *
 * 2026-10-07 修（#8）：计数从「插件实例级闭包」（=进程级）改成按 agent（会话）维度
 *   记账（stepsByAgent）——/new 重建会话后新会话第 1 步必注入，之后每 N 步一次；
 *   另加 turn1step1 新会话锚点（agent id 被复用时也能对齐回 0）。坑 ①② 原样保留。
 * 本模块不 import 任何 `@deepseek-ai/*` 内部包（与 index.js 同款零内部依赖约定）。
 */

import { randomUUID } from 'node:crypto';

/**
 * 每多少步注入一次（第 1 步 + 之后每 N 步：1, N+1, 2N+1…）。
 * ⚠️ 口径必须与 `DSH/hard-rules/index.mjs`（本机那份）保持一致。
 * 用户 2026-10-03 定：先按 10 步；若实际观察到遗忘，再改成 5 步。
 */
export const HARD_RULES_EVERY_N = 10;

/**
 * 造一个 `agent/pre-step` 处理器。
 *
 * @param {object} opts
 * @param {string} opts.text     最高指令原文（空 → 返回 null，调用方跳过挂载）。
 * @param {number} [opts.everyN] 注入间隔（步）。
 * @param {(msg: string) => void} [opts.log] 注入时打一行日志，便于真机验证接线。
 * @returns {((args: object, next: Function) => Promise<any>) | null}
 */
export function createHardRulesHandler({ text, everyN = HARD_RULES_EVERY_N, log = () => {} } = {}) {
  const body = String(text ?? '').trim();
  if (body.length === 0) return null;
  if (!Number.isInteger(everyN) || everyN < 1) {
    throw new TypeError(`HARD_RULES_EVERY_N 必须是正整数，收到 ${everyN}`);
  }

  /** 每个 agent（会话）各自的「有活干的步」数 —— 计数跟会话走，不跟进程走：
   *  /new 重建会话（新 agent id）后从 0 重新数，新会话第 1 步必注入
   *  （2026-10-07 老板判的病根：计数曾挂进程级闭包，新会话开头吃不到第 1 针，
   *  要等全局计数走到 11,21,… 才有下一针）。Map 键 = agent id，随进程生命周期存在。 */
  const stepsByAgent = new Map();
  /** 上一步的身份键（含 agent id），用于抵消双挂载带来的重复触发。 */
  let lastKey = null;

  return async function hardRulesHandler(args, next) {
    const claimed = Array.isArray(args?.messages) ? args.messages : [];
    // 坑 ①：空转步不记账、不注入，但仍要走完链（把宿主决定原样交回去）。
    if (claimed.length === 0) return next();

    const agentKey = String(args?.agent?.id ?? '');
    const key = `${agentKey}:${args?.turn ?? '?'}:${args?.step ?? '?'}`;
    // 坑 ②：同一步的第二次触发不重复计数（下一次遇到新键时才刷新 lastKey）。
    // ⚠️ 必须先做去重、再动任何记账状态 —— 双挂载的第二次触发若先跑下面的
    //    turn1step1 锚点，会把第一步刚记的账删掉（2026-10-07 实测踩过）。
    if (key === lastKey) return next();
    lastKey = key;
    // 新会话锚点：agent 的 turn1step1 必然是新会话的第一步 —— 即使 agent id 被复用
    // 也能把计数对齐回 0（幂等：真新会话本来就从 0 数）。
    if (Number(args?.turn) === 1 && Number(args?.step) === 1) stepsByAgent.delete(agentKey);
    const steps = (stepsByAgent.get(agentKey) ?? 0) + 1;
    stepsByAgent.set(agentKey, steps);

    const decision = await next();
    if (decision?.kind === 'reject') return decision;
    if (steps % everyN !== 1) return decision;

    const messages = Array.isArray(decision?.messages) ? decision.messages : null;
    if (messages === null) return decision;

    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: body }],
      source: { kind: 'hard-rules' },
    };
    // 插在「本步待发消息」之后、宿主追加 context 之前 —— 与 dsh-agent-instructions 同款位置。
    const at = messages.findLastIndex((m) => claimed.includes(m));
    log(`最高指令已注入（agent ${agentKey || '(无 id)'} 第 ${steps} 步）`);
    return { ...decision, messages: messages.toSpliced(at + 1, 0, message) };
  };
}

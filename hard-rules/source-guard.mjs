/**
 * source-guard — 「结论不标来源就打回」闸（拦截型，不是提示型）。
 *
 * 机制（✅ 源码实证，@deepseek-ai/dsh-agent-loop/lib/index.js）：
 *   · `agent/turn-stopping` 在「模型不再需要回应、回合即将关闭」时触发（998-1002 行）；
 *     触发后 loop **重新检查** `inbox.nextStep.length === 0`，非空就不关、再走一步（1005 行）。
 *   · listener 里 `agent.steer(msg)` = `send(msg, "next-step", true)`（809-811 行）
 *     → 正好把回合续上一步。官方 hooks 插件就是这么打回的
 *     （@deepseek-ai/dsh-hooks-claude-code/lib/index.js:292-308）。
 *
 * 本插件做两件事：
 *   ① 监听 `agent/assistant-stream`，按 agent 累积**最后一次**模型输出的文本
 *      （`start` 帧重置、`text-delta` 追加）——最后一次 = 最终回复；
 *   ② `agent/turn-stopping` 时检查这段文本有没有来源档位标记；
 *      没有 → steer 一条提醒把回合打回，让模型补齐再收尾；
 *      **同一回合最多打回 1 次**（防死循环）。
 *
 * ⚠️ 刻意不 import 任何 `@deepseek-ai/*` 内部包（照 hard-rules 的先例）：
 *    手搓同形状的 user message，插件才能被独立装/卸。
 * ⚠️ 事件要挂 ctx 与 ctx.root 两份（agent 作用域事件，挂一份会漏）。
 *    两份挂载会收到同一帧 / 同一次 turn-stopping → 用帧对象身份 + (agent, turn) 去重。
 * ⚠️ 词表 / 阈值 / 开关都在 config 里，改行为不用动逻辑。
 */

import { randomUUID } from 'node:crypto';

/** Cordis 插件名。 */
export const name = 'source-guard';

/** 默认判定：出现任一个就算「标了来源」。 */
const DEFAULT_MARK_RE = '✅|⚠️|🔴|已验证|推断|来源不明';

/** 短于此长度不检查（寒暄 / 确认类不需要档位）。 */
const DEFAULT_MIN_LEN = 40;

/** 打回时给模型的话。 */
const REMINDER = [
  '【来源闸】你刚发出的回复没有标来源档位，被拦下了。',
  '请给结论补上档位后重新收尾：',
  '  · ✅ 已验证 = 能当场贴出命令 + 输出；',
  '  · ⚠️ 推断 = 有依据但没实测（写明依据）；',
  '  · 🔴 来源不明 = 没查过。',
  '⛔ 不许把推断包装成已验证；纯寒暄/确认不算结论，可不标。',
].join('\n');

/** 手搓一条 user message（形状与上游 createUserMessage 一致）。 */
function userMessage(text, kind) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
  };
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{enabled?:boolean, markRe?:string, minLen?:number, sourceKind?:string}} [config]
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  let markRe;
  try {
    markRe = new RegExp(config.markRe ?? DEFAULT_MARK_RE);
  } catch {
    markRe = new RegExp(DEFAULT_MARK_RE);
  }
  const minLen = Math.max(0, Number(config.minLen ?? DEFAULT_MIN_LEN) || 0);
  const kind = config.sourceKind ?? 'source-guard';

  /** 每个 agent 最近一次模型输出文本。 */
  const bufs = new Map();
  /** 每个 agent 已经打回过的回合号。 */
  const bounced = new Map();
  /** 帧对象身份去重（同一帧会被两份挂载各收到一次）。 */
  const seenFrames = new WeakSet();

  const onStream = (payload = {}) => {
    const agent = payload.agent;
    const frame = payload.frame;
    const id = agent?.id;
    if (!id || !frame) return;
    if (seenFrames.has(frame)) return;
    seenFrames.add(frame);
    if (frame.type === 'start') {
      bufs.set(id, '');
      return;
    }
    if (frame.type !== 'chunk') return;
    const chunk = frame.chunk;
    if (chunk?.type !== 'text-delta') return;
    bufs.set(id, (bufs.get(id) ?? '') + String(chunk.text ?? ''));
  };

  const onStopping = (payload = {}) => {
    const agent = payload.agent;
    const turn = payload.turn;
    const id = agent?.id;
    if (!id) return;
    const text = (bufs.get(id) ?? '').trim();
    if (text.length < minLen) return;
    if (markRe.test(text)) return;
    if (bounced.get(id) === turn) return;
    if (typeof agent.steer !== 'function') {
      console.error('[source-guard] agent.steer 不可用，跳过打回');
      return;
    }
    bounced.set(id, turn);
    try {
      agent.steer(userMessage(REMINDER, kind));
      console.error(`[source-guard] 打回：turn=${turn} agent=${String(id).slice(0, 8)} 文本 ${text.length} 字（无来源档位）`);
    } catch (err) {
      console.error(`[source-guard] 打回失败: ${err?.message ?? err}`);
    }
  };

  const targets = ctx.root && ctx.root !== ctx ? [ctx, ctx.root] : [ctx];
  let mounted = 0;
  for (const target of targets) {
    if (typeof target?.on !== 'function') continue;
    try {
      target.on('agent/assistant-stream', onStream);
      target.on('agent/turn-stopping', onStopping);
      mounted += 1;
    } catch (err) {
      console.error(`[source-guard] 挂载失败: ${err?.message ?? err}`);
    }
  }
  console.error(`[source-guard] 已挂载（${mounted} 处）｜判定 /${markRe.source}/｜最短 ${minLen} 字｜每回合最多打回 1 次`);
}

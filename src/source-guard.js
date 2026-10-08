/**
 * 来源闸（source-guard）—— 结论不标来源就打回（拦截型，不是提示型）。
 *
 * 机制（✅ 源码实证，@deepseek-ai/dsh-agent-loop/lib/index.js）：
 *   · `agent/turn-stopping` 在「模型不再需要回应、回合即将关闭」时触发（998-1002 行）；
 *     触发后 loop 重新检查 `inbox.nextStep.length === 0`，非空就不关、再走一步（1005 行）。
 *   · listener 里 `agent.steer(msg)` = `send(msg, "next-step", true)`（809-811 行）
 *     → 正好把回合续上一步。官方 hooks 插件也是这么打回的
 *     （@deepseek-ai/dsh-hooks-claude-code/lib/index.js:292-308）。
 *
 * 做法：
 *   ① 监听 `agent/assistant-stream`，按 agent 累积**最后一次**模型输出文本
 *      （`start` 帧重置、`text-delta` 追加）——最后一次 = 最终回复；
 *   ② `agent/turn-stopping` 时检查这段文本有没有来源档位标记；没有 → steer 一条提醒打回，
 *      让模型补齐再收尾；**同一回合最多打回 1 次**（防死循环）。
 *
 * ⚠️ 权威源 = `/Users/tcm/DSH/hard-rules/source-guard.mjs`（web profile patch file:// 引用，
 *    原样收进本仓 hard-rules/ 目录，commit 6a5fa62）。本文件 = 同一功能的**内置装载镜像**
 *    （形状不同：apply(ctx,config) → createSourceGuardInstaller，服务 npm 包内 import），
 *    同一套判定词表与节奏，改行为必须先改权威源、再同步这里（第 1 条：一份权威源）。
 * ⚠️ 本模块不 import 任何 `@deepseek-ai/*` 内部包（与 index.js 同款约定）。
 */

import { randomUUID } from 'node:crypto';

/** 默认判定：出现任一个就算「标了来源」。 */
export const SOURCE_GUARD_MARK_RE = '✅|⚠️|🔴|已验证|推断|来源不明';

/** 短于此长度不检查（寒暄 / 确认类不需要档位）。 */
export const SOURCE_GUARD_MIN_LEN = 40;

/** 打回时给模型的话。 */
export const SOURCE_GUARD_REMINDER = [
  '【来源闸】你刚发出的回复没有标来源档位，被拦下了。',
  '请给结论补上档位后重新收尾：',
  '  · ✅ 已验证 = 能当场贴出命令 + 输出；',
  '  · ⚠️ 推断 = 有依据但没实测（写明依据）；',
  '  · 🔴 来源不明 = 没查过。',
  '⛔ 不许把推断包装成已验证；纯寒暄/确认不算结论，可不标。',
].join('\n');

/**
 * 造一个「来源闸」安装器。返回的函数对每个 cordis target（ctx / ctx.root）各调一次。
 *
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log] 挂载 / 打回时打一行日志，便于真机验证接线。
 * @param {string} [opts.markRe] 判定正则源串（默认见 SOURCE_GUARD_MARK_RE）。
 * @param {number} [opts.minLen] 最短检查长度（默认 SOURCE_GUARD_MIN_LEN）。
 * @returns {(target: object) => boolean} install(target) —— 挂上返回 true。
 */
export function createSourceGuardInstaller({ log = () => {}, markRe, minLen = SOURCE_GUARD_MIN_LEN } = {}) {
  let mark;
  try {
    mark = new RegExp(markRe ?? SOURCE_GUARD_MARK_RE);
  } catch {
    mark = new RegExp(SOURCE_GUARD_MARK_RE);
  }
  const min = Math.max(0, Number(minLen) || 0);

  /** 每个 agent（会话）最近一次模型输出文本。 */
  const bufs = new Map();
  /** 每个 agent 已经打回过的回合号（同一回合只打回一次）。 */
  const bounced = new Map();
  /** 帧对象身份去重（ctx / ctx.root 双挂载会收到同一帧两次）。 */
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
    if (text.length < min) return;
    if (mark.test(text)) return;
    if (bounced.get(id) === turn) return;
    if (typeof agent.steer !== 'function') {
      log('来源闸：agent.steer 不可用，跳过打回');
      return;
    }
    bounced.set(id, turn);
    try {
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: SOURCE_GUARD_REMINDER }],
        source: { kind: 'source-guard' },
      });
      log(`来源闸打回：第 ${turn} 回合（文本 ${text.length} 字，未标来源档位）`);
    } catch (err) {
      log(`来源闸打回失败：${err?.message ?? err}`);
    }
  };

  return function install(target) {
    if (typeof target?.on !== 'function') return false;
    try {
      target.on('agent/assistant-stream', onStream);
      target.on('agent/turn-stopping', onStopping);
      return true;
    } catch (err) {
      log(`来源闸挂载失败：${err?.message ?? err}`);
      return false;
    }
  };
}

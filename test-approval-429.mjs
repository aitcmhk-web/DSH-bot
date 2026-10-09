/**
 * #48 回归：审批卡片的 429 感知重试（src/approval-bridge.js）。
 *
 * 用假 telegram 客户端驱动，不连真 TG、不读真 token：
 *   A) 正向：第 1 次 sendMessage 429 → 按 retry-after 等待重试成功 → 卡片送达、
 *      按钮放行 → 审批结果 allowed-once（通道不再被限流打断）；
 *   B) 反向④：始终 429 → 共 3 次尝试 → 耗尽后 next() 让位 = 失败关闭语义不变；
 *   C) 回归：telegram 缺位 → 同步让位（原有行为）。
 *
 * 运行：node test-approval-429.mjs
 */
import { installApprovalBridge } from './src/approval-bridge.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假插件 ctx：只实现 approval-bridge 用到的 on()，并把监听器存下来供触发。 */
function fakeCtx() {
  const handlers = new Map();
  return {
    ctx: {
      on: (event, fn) => {
        handlers.set(event, fn);
        return () => handlers.delete(event);
      },
      root: null,
    },
    fire: (event, ...args) => handlers.get(event)?.(...args),
  };
}

/**
 * 假 TG 客户端：sendMessage 按 script 逐次决定行为（'429' = 抛限流，其它 = 成功），
 * script 耗尽后重复最后一项。全程只记调用，不发网络请求。
 */
function fakeTelegram(script) {
  const calls = [];
  let step = 0;
  return {
    calls,
    async sendMessage(chatId, text, opts) {
      calls.push({ method: 'sendMessage', chatId, text, opts });
      const action = script[Math.min(step, script.length - 1)];
      step += 1;
      if (action === '429') throw new Error('sendMessage: Too Many Requests: retry after 1');
      return { message_id: calls.length };
    },
    async editMessageText() {
      calls.push({ method: 'editMessageText' });
      return {};
    },
    async answerCallbackQuery() {
      calls.push({ method: 'answerCallbackQuery' });
      return {};
    },
  };
}

/** 最小 approval/request 载荷（session.seq=0 → command 反查直接落空，不影响审批）。 */
const baseRequest = () => ({
  toolName: 'bash',
  displayReason: '测试提权',
  callId: 'c1',
  agent: { session: { seq: 0, eventAt: () => null } },
});

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '⛔'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

/* ---------- A) 正向：429 一次 → 重试成功 → 卡片送达 → 按钮放行 ---------- */
{
  const { ctx, fire } = fakeCtx();
  const tg = fakeTelegram(['429', 'ok']);
  const bridge = installApprovalBridge({
    ctx,
    telegram: tg,
    getChatId: () => 42,
    log: (m) => console.log(`  [A] ${m}`),
    error: (m) => console.log(`  [A!] ${m}`),
  });
  let nextCalled = false;
  const decision = fire('approval/request', baseRequest(), () => {
    nextCalled = true;
    return 'unavailable';
  });
  await sleep(2500); // 第一次尝试即 429 → 等 1s → 第二次成功
  const sends = tg.calls.filter((c) => c.method === 'sendMessage');
  check('A1 重试发生（sendMessage 共 2 次：429 + 成功）', sends.length === 2, `实际 ${sends.length}`);
  check('A2 未让位（next 未被调用）', nextCalled === false);
  const buttons = sends.at(-1)?.opts?.reply_markup?.inline_keyboard?.[0] ?? [];
  const okBtn = buttons.find((b) => String(b.callback_data ?? '').startsWith('appr:ok:'));
  check('A3 卡片带放行按钮', Boolean(okBtn));
  const id = String(okBtn?.callback_data ?? '').slice('appr:ok:'.length);
  const handled = bridge.handleApprovalCallback(`appr:ok:${id}`, {
    id: 'q1',
    message: { chat: { id: 42 }, message_id: sends.at(-1)?.message_id },
  });
  check('A4 按钮回调被桥接管', handled === true);
  const outcome = await decision;
  check('A5 审批结果 = allowed-once', outcome === 'allowed-once', `实际 ${outcome}`);
  bridge.dispose();
}

/* ---------- B) 反向④：始终 429 → 3 次尝试耗尽 → next() 让位（失败关闭） ---------- */
{
  const { ctx, fire } = fakeCtx();
  const tg = fakeTelegram(['429']);
  const bridge = installApprovalBridge({
    ctx,
    telegram: tg,
    getChatId: () => 42,
    log: (m) => console.log(`  [B] ${m}`),
    error: (m) => console.log(`  [B!] ${m}`),
  });
  let nextCalled = false;
  const outcome = await fire('approval/request', baseRequest(), () => {
    nextCalled = true;
    return 'unavailable';
  });
  const sends = tg.calls.filter((c) => c.method === 'sendMessage');
  check('B1 重试共 3 次尝试后停止', sends.length === 3, `实际 ${sends.length}`);
  check('B2 耗尽后让位（next 已调用）', nextCalled === true);
  check('B3 结果 = unavailable（失败关闭不哑等）', outcome === 'unavailable', `实际 ${outcome}`);
  bridge.dispose();
}

/* ---------- C) 回归：telegram 缺位 → 同步让位 ---------- */
{
  const { ctx, fire } = fakeCtx();
  const bridge = installApprovalBridge({
    ctx,
    telegram: null,
    getChatId: () => 42,
    log: () => {},
    error: () => {},
  });
  let nextCalled = false;
  const outcome = fire('approval/request', baseRequest(), () => {
    nextCalled = true;
    return 'unavailable';
  });
  check('C1 telegram 缺位 → 同步让位', nextCalled === true && outcome === 'unavailable', `实际 ${outcome}`);
  bridge.dispose();
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ⛔`);
process.exit(failed === 0 ? 0 : 1);

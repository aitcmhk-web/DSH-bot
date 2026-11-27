/**
 * test-turn-guards.mjs —— 回合守卫回归（2026-11-27 修 P0#3 / P0#4）。
 *
 * 为什么单独一份：这两条的症状都是「过一阵子才哑」，不是当场报错 ——
 *   · P0#3 `waitForTurn` 在会话还没建时不留 id（`sessionId !== null &&` 放行），
 *     别人的 turn/end 会把这一轮收掉：串话、答案被别的会话收走、/new 后必踩；
 *   · P0#4 命令入口绕过队列直接 resetSession，旧回合等不到 turn/end，
 *     这条会话一直卡到 turnTimeoutMs（线上 3 小时）。
 *   没有用例的话，改回去也全绿。
 *
 * 覆盖：
 *   ① 会话未建时，别人的 / 空 sessionId 的 turn/end 一律不结算；
 *   ② 本会话的 assistant/message + turn/end 正常结算并带回文字；
 *   ③ 宿主另发会话 id（agent.id ≠ 预分配 id）时，靠活句柄 id 兜住，不死等超时；
 *   ④ 命令排队策略：/new、/model 排队，/restart 免排队（卡死自救那条路）。
 *
 * 跑法：node test-turn-guards.mjs
 * 退出码：0 = 全过；1 = 有用例失败。
 */

import { BotRuntime } from './src/runtime.js';
import { 要排队 } from './src/command-policy.js';

let failed = 0;
const check = (cond, msg) => {
  if (cond) console.log(`✅ ${msg}`);
  else {
    console.error(`❌ ${msg}`);
    failed += 1;
  }
};

const 睡 = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 造一个假宿主：agents.create 直接给句柄，事件用 emit() 手动喂。
 * @param {{idOverride?:(sessionId:string)=>string}} [opts]
 */
function 造(opts = {}) {
  const listeners = [];
  const ctx = {
    on() {},
    agents: {
      async create({ sessionId }) {
        const id = opts.idOverride ? opts.idOverride(sessionId) : sessionId;
        const agent = {
          id,
          followup() {},
          on(_evt, cb) {
            listeners.push(cb);
          },
          session: {},
        };
        return { id, agent, dispose() {} };
      },
      async resume() {
        throw new Error('这条用例不该走到 resume');
      },
    },
  };
  const store = new Map();
  const runtime = new BotRuntime({
    ctx,
    route: { provider: 'p', model: 'm' },
    sessionIds: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) },
  });
  const emit = (sessionId, event) => {
    for (const cb of [...listeners]) cb({ sessionId, event });
  };
  return { runtime, emit };
}

// ---- ① / ② 会话未建时不许被别人结算 ----
{
  const { runtime, emit } = 造();
  const 等 = runtime.waitForTurn('wx:甲', 2000);
  const 投递 = await runtime.prompt('wx:甲', '你好');
  check(投递.ok === true, '假宿主 prompt 投递成功');

  const 我的 = runtime.sessionIdOf('wx:甲');
  emit('wx:乙', { type: 'turn/end', data: { reason: { kind: 'ok' } } });
  emit('', { type: 'turn/end', data: { reason: { kind: 'ok' } } });
  const 中途 = await Promise.race([等.then(() => '被结算'), 睡(60).then(() => '仍在等')]);
  check(中途 === '仍在等', '别人的 / 空 sessionId 的 turn/end 不结算这一轮');

  emit(我的, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在' }] } } });
  emit(我的, { type: 'turn/end', data: { reason: { kind: 'ok' } } });
  const 结果 = await 等;
  check(结果.ok === true && 结果.text === '在', '本会话正常结算，并带回这一轮的文字');
}

// ---- ③ 宿主另发会话 id（agent.id ≠ 预分配 id） ----
{
  const { runtime, emit } = 造({ idOverride: (sid) => `srv:${sid}` });
  const 等 = runtime.waitForTurn('wx:丙', 2000);
  await runtime.prompt('wx:丙', '你好');
  const 活 = runtime.sessionIdOf('wx:丙');
  check(活.startsWith('srv:'), '活句柄 id 由宿主另发（模拟）');
  emit(活, { type: 'turn/end', data: { reason: { kind: 'ok' } } });
  const 结果 = await 等;
  check(结果.ok === true, '活句柄 id 与预分配 id 不同时也能结算，不死等超时');
}

// ---- ④ 命令排队策略 ----
check(要排队('/new') === true, '/new 必须排队（会 resetSession）');
check(要排队('/model') === true, '/model 必须排队（会切会话档位）');
check(要排队('/restart') === false, '/restart 免排队——卡死时它要能立刻生效');
check(要排队('/status') === false, '/status 免排队——卡死时正是要看它');
check(要排队('/whoami') === false, '/whoami 免排队（只读）');
check(要排队('/RESTART') === false, '命令大小写归一后再判');
check(要排队('') === true, '空命令按排队处理（保守）');

if (failed > 0) {
  console.error(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n✅ 回合守卫用例全过');

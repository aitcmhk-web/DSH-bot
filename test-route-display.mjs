/**
 * 集成回归：跟随宿主（useHostRoutes）时，菜单 ✅ 与 /status 的模型显示。
 *
 * 这是 2026-09-29 用户报障的现场：插件版菜单里「模型选择」和「查看当前状态」
 *   的模型都指向 web 端默认档（glm-5.3-flash ✅），可实际切换是成功的。
 * 根因：refreshHostRoute() 每次刷新把 activeRoute 覆盖回默认档，而切换分支
 *   `if (!useHostRoutes) activeRoute = wanted;` 在跟随宿主时**根本不记**这个选择。
 *   ⇒ 显示永远被打回默认档（切换本身没问题，是"记不住"）。
 *
 * 本测试不复制插件逻辑：起假 Telegram API → 走真的 apply() → 真的长轮询
 *   → 真的 handleCommand('/model') → 真的 callback 分支 → 截下真实发出的文本。
 * 假宿主提供 settings/llm 两个服务，模拟 web 端的两条模型档位。
 *
 * 跑法：node test-route-display.mjs
 */

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failed = 0;
// ⚠️ 走 stderr：本测试会临时接管 console.log 来收插件日志，用 console.log 报结果
//    会被自己的收集器吞掉（本次就出现"只剩 1 项失败、断言全看不见"）。
const ok = (cond, msg) => {
  process.stderr.write(`${cond ? '✅' : '❌'} ${msg}\n`);
  if (!cond) failed++;
};

// ⚠️ 必须用临时 cwd：插件的单实例锁落在 cwd/.botplugin.lock，占 cwd 就会写到
//    真身 bot.js 的目录里去（本次就撞上过一次），属于污染生产环境。
const WORKDIR = mkdtempSync(join(tmpdir(), 'botplugin-routedisplay-'));

const TG_PORT = 18953;

// ── 假宿主：settings.yaml 视角 ────────────────────────────────────────────
// 两条档位：zhipu/glm-5.3-flash（web 端默认档）+ zhipu/glm-4.7-flash（要切过去的那条）。
// 键规则照抄插件：单模型 provider 用别名，多模型 <别名>:<模型id> → zhipu 有 2 个模型。
const SECTIONS = {
  'agent-default-model': { provider: 'zhipu', model: 'glm-5.3-flash' },
  'llm-pi-ai': {
    providers: {
      zhipu: {
        apiKeyEnv: 'ZHIPU_API_KEY',
        api: 'openai-completions',
        baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
        models: [
          { id: 'glm-5.3-flash', name: 'glm-5.3-flash' },
          { id: 'glm-4.7-flash', name: 'glm-4.7-flash' },
        ],
      },
    },
  },
};

// ── 假 Telegram：把 bot 发出的每条消息记下来 ──────────────────────────────
const sent = [];
const updateQueue = [];
let pollWaiter = null;

const tg = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const json = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  // 插件走 JSON body（src/telegram.js:34 `content-type: application/json`）。
  const params = JSON.parse(body || '{}');

  if (url.pathname.includes('/getMe')) {
    return json({ ok: true, result: { id: 999, is_bot: true, username: 'testbot' } });
  }
  if (url.pathname.includes('/getUpdates')) {
    if (updateQueue.length === 0) {
      await new Promise((r) => {
        pollWaiter = r;
        setTimeout(r, 300);
      });
      pollWaiter = null;
    }
    const batch = updateQueue.splice(0, updateQueue.length);
    return json({ ok: true, result: batch });
  }
  if (url.pathname.includes('/sendMessage')) {
    sent.push({
      chat_id: params.chat_id,
      text: params.text ?? '',
      reply_markup: params.reply_markup,
    });
    return json({ ok: true, result: { message_id: sent.length, chat: { id: params.chat_id } } });
  }
  if (url.pathname.includes('/answerCallbackQuery')) return json({ ok: true, result: true });
  if (url.pathname.includes('/sendChatAction')) return json({ ok: true, result: true });
  return json({ ok: true, result: {} });
});
await new Promise((r) => tg.listen(TG_PORT, '127.0.0.1', r));

// ── 假宿主 agent / ctx ────────────────────────────────────────────────────
const sessionListeners = [];
let createdCount = 0;
let billingFailNext = false;
const agent = { id: 'botplugin:tg:4242' };
agent.followup = () => {
  setTimeout(() => {
    for (const fn of sessionListeners) {
      // 欠费闸门：打开时这一轮以「余额不足」失败，用来验自动换档。
      if (billingFailNext) {
        fn(
          { id: agent.id },
          {
            type: 'turn/end',
            data: {
              reason: { kind: 'error', error: { errorCode: 402, message: 'Insufficient Balance' } },
            },
          },
        );
        return;
      }
      fn({ id: agent.id }, { type: 'turn/end', data: { reason: 'completed' } });
    }
  }, 5);
};

const ctx = {
  agents: {
    create: async () => {
      createdCount++;
      return { agent };
    },
    get: (id) => (id === agent.id ? agent : undefined),
    resume: async () => ({ agent }),
  },
  attachments: { admitPromptContent: async (b) => b },
  settings: { get: (ns) => SECTIONS[ns] ?? {} },
  llm: { listProviders: () => [{ id: 'zhipu' }], listModels: async () => [] },
  // ⚠️ 插件全部走 ctx.get('settings') / ctx.get('llm') 取服务（Cordis inject 口径），
  //    只挂直接属性是拿不到的 —— 漏了这个，模型表会静默为空、菜单报"(未配置)"。
  get: (name) => ctx[name],
  on(evt, fn) {
    if (evt === 'session/event') sessionListeners.push(fn);
  },
};

const plugin = await import('./src/index.js');
// 插件记日志直接走 console（src/runtime.js:55 `console.log('[botplugin]', ...)`、
// src/index.js:108 makeLog）—— 不是 ctx.log，所以必须拦 console 才收得到。
const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.map(String).join(' ')); };
process.on('exit', () => { console.log = realLog; });
plugin.apply(
  ctx,
  {
    telegramToken: 'TOKEN',
    telegramApiRoot: `http://127.0.0.1:${TG_PORT}`,
    telegramAllowedUsers: [],
    cwd: WORKDIR,
    turnTimeoutMs: 4000,
    // routes 留空 ⇒ useHostRoutes = true（就是这个模式的显示出过问题）
  },
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sendUpdate = (u) => {
  updateQueue.push(u);
  if (pollWaiter) pollWaiter();
};
const userMsg = (id, text) => ({
  update_id: id,
  message: {
    message_id: id,
    from: { id: 4242, is_bot: false, first_name: 'T' },
    chat: { id: 4242, type: 'private' },
    date: Math.floor(Date.now() / 1000),
    text,
  },
});
const cbUpdate = (id, data) => ({
  update_id: id,
  callback_query: {
    id: `cb${id}`,
    from: { id: 4242, is_bot: false, first_name: 'T' },
    message: { message_id: 500 + id, chat: { id: 4242, type: 'private' } },
    data,
  },
});
/** 取菜单里的「当前：…」那一行（菜单是单行文本，不能按下标猜）。 */
const currentLine = (m) =>
  (m?.text ?? '').split('\n').find((l) => l.startsWith('当前：')) ?? '(没找到当前行)';

/** 等新消息落地，返回最后一条发出的文本。 */
const waitForReply = async (minCount, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (sent.length < minCount && Date.now() < deadline) await wait(50);
  return sent[sent.length - 1];
};
/** 等一条 /status 回执（含「模型: 」行），从第 `from` 条起往后找。 */
const waitForStatus = async (from, ms = 4000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = sent.slice(from - 1).find((m) => (m.text ?? '').includes('模型: '));
    if (hit) return hit;
    if (Date.now() > deadline) return undefined;
    await wait(50);
  }
};

/**
 * 等一条**带按钮的菜单**消息（从第 `from` 条起往后找）。
 * ⚠️ 不能按序号取：切模型会连发若干条（回执 + 会话回话），序号会错位 ——
 *    本次就因此把"回执"当成菜单读了，误判成显示没跟着走。
 */
const waitForMenu = async (from, ms = 4000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = sent.slice(from - 1).find((m) => m.reply_markup?.inline_keyboard?.length);
    if (hit) return hit;
    if (Date.now() > deadline) return undefined;
    await wait(50);
  }
};

await wait(400); // 等长轮询起来 + 默认档就绪

// ── 场景 1：初始菜单应指着 web 端默认档 ──────────────────────────────────
sendUpdate(userMsg(1, '/model'));
const menu1 = await waitForMenu(1);
const btns1 = (menu1?.reply_markup?.inline_keyboard ?? []).map((row) => row[0]);
ok(
  btns1.find((b) => b.text.endsWith('✅'))?.text === 'zhipu:glm-5.3-flash ✅',
  `初始 ✅ 在默认档上（实际：${JSON.stringify(btns1.map((b) => b.text))}）`,
);
// ⚠️ 断言必须落在**模型 id** 上：菜单「当前」行格式是
//    `当前：<label>（<provider> / <model>）`，label 两条档位可能同名，
//    只比对 label 根本区分不出切没切 —— 那正是这个 bug 之前能藏住的原因。
// ⚠️ 也不能拿整段文本去断言"没有 glm-4.7-flash"：菜单下半部分「启动回退顺序」
//    会把每条档位都列一遍，整段必然包含它（本次就因此误判）。只看「当前」行。
ok(
  currentLine(menu1).includes('glm-5.3-flash'),
  `初始「当前」写的是默认档 glm-5.3-flash（实际：${currentLine(menu1)}）`,
);

// ── 场景 2：点按钮切到 glm-4.7-flash（插件版失败的正是这一步之后的显示）──
const target = btns1.find((b) => b.text.startsWith('zhipu:glm-4.7-flash'));
ok(target !== undefined, '菜单里能找到 glm-4.7-flash 那条');
sendUpdate(cbUpdate(2, target.callback_data));
const ack = await waitForReply(2);
ok(
  ack?.text?.includes('已切换到') && ack.text.includes('glm-4.7-flash'),
  `切换回执确认切到 glm-4.7-flash（实际：${JSON.stringify(ack?.text?.slice(0, 60))}）`,
);

// ── 场景 3【核心】：切完再打开菜单，✅ 必须跟着走 ────────────────────────
const menuMark = sent.length; // 记住切换前已发出的条数，之后的菜单才算数
sendUpdate(userMsg(3, '/model'));
const menu2 = await waitForMenu(menuMark + 1);
const btns2 = (menu2?.reply_markup?.inline_keyboard ?? []).map((row) => row[0]);
ok(
  btns2.find((b) => b.text.endsWith('✅'))?.text === 'zhipu:glm-4.7-flash ✅',
  `⭐ 切换后 ✅ 必须在 glm-4.7-flash 上（报障症状 = 一直停在 glm-5.3-flash；实际：${JSON.stringify(
    btns2.map((b) => b.text),
  )}）`,
);
ok(
  btns2.filter((b) => b.text.endsWith('✅')).length === 1,
  `✅ 恰好一个，不会出现两个（实际 ${btns2.filter((b) => b.text.endsWith('✅')).length} 个）`,
);
ok(
  menu2?.text?.includes('当前：zhipu（zhipu / glm-4.7-flash）'),
  `切换后菜单「当前」跟着走到 glm-4.7-flash（实际：${currentLine(menu2)}）`,
);

// ── 场景 4【核心】：/status 的模型行也必须跟着走 ─────────────────────────
const statusMark = sent.length;
sendUpdate(userMsg(4, '/status'));
const status = await waitForStatus(statusMark + 1);
const modelLine = (status?.text ?? '').split('\n').find((l) => l.startsWith('模型: '));
ok(
  modelLine?.includes('glm-4.7-flash'),
  `⭐ /status 的模型行是 glm-4.7-flash（报障症状 = glm-5.3-flash；实际：${modelLine}）`,
);

// ── 场景 5：多轮刷新后仍然稳（防止"下一次派发前刷新"又把它冲掉）─────────
const statusMark2 = sent.length;
for (let i = 5; i <= 7; i++) sendUpdate(userMsg(i, '/status'));
const status2 = await waitForStatus(statusMark2 + 3);
const modelLine2 = (status2?.text ?? '').split('\n').find((l) => l.startsWith('模型: '));
ok(
  modelLine2?.includes('glm-4.7-flash'),
  `连续刷新后 /status 不被默认档冲回（实际：${modelLine2}）`,
);

// ── 场景 6：切换必须真的落到会话上（显示对了不能是"只改显示"）────────────
//    判据取 runtime 真实建会话时打的日志行 —— 直接看它换没换 provider/model，
//    比数 create() 次数可靠：假 agent 的 id 是固定的，不会因为切档位就多建一个。
const sessionLines = logs.filter((l) => l.includes('session created for'));
ok(
  sessionLines.some((l) => l.includes('zhipu/glm-4.7-flash')),
  `⭐ 切换真的把会话建到了 glm-4.7-flash 上（实际日志：${JSON.stringify(sessionLines)}）`,
);

// ── 场景 6b【2026-09-30 报障】：欠费必须自动跳到下一个档 ──────────────────
//    报障原文：「当模型欠费返回错误时，它不能自动跳到下一个模型」。
//    根因：isRouteFailure() 写好了但**从没被调用** —— 失败分支只回一句
//    「❌ 处理失败」就 return，判得出来却不切。
//    ⚠️ 判据取「用户实际收到的消息」+「runtime 真的把会话建到新档上」，
//       不是"代码里有没有那段逻辑"。
const beforeFailover = sent.length;
const beforeSessionCount = logs.filter((l) => l.includes('session created for')).length;
billingFailNext = true;
updateQueue.push(userMsg(102, '这笔多少钱？'));
await wait(1200);
billingFailNext = false;

const failoverMsgs = sent.slice(beforeFailover).map((m) => m.text);
ok(
  failoverMsgs.some((t) => t.includes('自动切换到')),
  `⭐⭐ 欠费时告诉用户已自动换档（实际：${JSON.stringify(failoverMsgs)}）`,
);
ok(
  !failoverMsgs.some((t) => t.startsWith('❌ 处理失败') || t.startsWith('❌ Insufficient')),
  `⭐⭐ 不再是干巴巴一句报错（实际：${JSON.stringify(failoverMsgs)}）`,
);
const afterSessionCount = logs.filter((l) => l.includes('session created for')).length;
ok(
  afterSessionCount > beforeSessionCount,
  `⭐⭐ 换档真的重建了会话（重试前 ${beforeSessionCount} 次 → 重试后 ${afterSessionCount} 次）`,
);
ok(
  logs.some((l) => l.includes('自动切到')),
  `⭐ 日志里有换档记录（实际：${JSON.stringify(logs.filter((l) => l.includes('自动切到')))})`,
);

// ── 场景 7【核心·2026-09-30 报障】：记忆必须活过**重启** ──────────────────
//    报障原文：「插件那边重启后模型又回默认的了，正常应该不切换才对，除非我主动切换」。
//    原实现把记忆位放在内存里（let hostPickedKey = null），进程一换就归零 → 回落默认档。
//    这里模拟真实重启：**同一个 cwd 再 apply() 一次**（新进程等价于新的一次 apply，
//    模块状态本来就随进程消失，而落盘文件留在 cwd）。
//    ⚠️ 判据必须是「重启后的菜单 ✅ / 当前行」，不是"文件里有没有那个 key" ——
//       写了文件但启动时没读回来，正是这个 bug 的形态。
tg.close();
await wait(100);

const sent2 = [];
const tg2 = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const json = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  const params = JSON.parse(body || '{}');
  if (url.pathname.includes('/getMe')) {
    return json({ ok: true, result: { id: 999, is_bot: true, username: 'testbot' } });
  }
  if (url.pathname.includes('/getUpdates')) {
    if (updateQueue2.length === 0) await new Promise((r) => setTimeout(r, 300));
    return json({ ok: true, result: updateQueue2.splice(0, updateQueue2.length) });
  }
  if (url.pathname.includes('/sendMessage')) {
    sent2.push({ chat_id: params.chat_id, text: params.text ?? '', reply_markup: params.reply_markup });
    return json({ ok: true, result: { message_id: sent2.length, chat: { id: params.chat_id } } });
  }
  return json({ ok: true, result: true });
});
const updateQueue2 = [];
const TG_PORT2 = 18954;
await new Promise((r) => tg2.listen(TG_PORT2, '127.0.0.1', r));

// 重启：同一个 WORKDIR（落盘文件就在那儿），重新 apply 一份全新进程状态。
plugin.apply(ctx, {
  telegramToken: 'TOKEN',
  telegramApiRoot: `http://127.0.0.1:${TG_PORT2}`,
  telegramAllowedUsers: [],
  cwd: WORKDIR,
  turnTimeoutMs: 4000,
});
await wait(400);
updateQueue2.push(userMsg(101, '/model'));
const deadline7 = Date.now() + 4000;
let menu3;
while (Date.now() < deadline7) {
  menu3 = sent2.find((m) => m.reply_markup?.inline_keyboard?.length);
  if (menu3) break;
  await wait(50);
}
const btns3 = (menu3?.reply_markup?.inline_keyboard ?? []).map((row) => row[0]);
ok(
  btns3.find((b) => b.text.endsWith('✅'))?.text === 'zhipu:glm-4.7-flash ✅',
  `⭐⭐ 重启后 ✅ 仍在用户手选的 glm-4.7-flash（报障症状 = 回落到 glm-5.3-flash；实际：${JSON.stringify(
    btns3.map((b) => b.text),
  )}）`,
);
ok(
  currentLine(menu3).includes('glm-4.7-flash'),
  `⭐⭐ 重启后「当前」行仍是 glm-4.7-flash（实际：${currentLine(menu3)}）`,
);

tg2.close();
rmSync(WORKDIR, { recursive: true, force: true });
console.log = realLog;
process.stderr.write(failed === 0 ? '\n全部通过\n' : `\n${failed} 项失败\n`);
process.exit(failed === 0 ? 0 : 1);

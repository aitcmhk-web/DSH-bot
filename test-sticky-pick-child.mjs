/**
 * test-sticky-pick.mjs 的子进程：在**假 HOME** 里真跑一遍插件，把 /status 的模型行吐回去。
 *
 * 为什么要拆子进程：插件的 web 端档位表是它**自己读文件**拿的
 *   （web-patch.js → `homedir()/.dsh/profiles/web/cordis.patch.yml`），
 *   而 `homedir()` 认的是进程启动时的 HOME。父进程改 HOME 影响不到已加载的模块缓存，
 *   也不该去改真 home —— 只能起新进程、在干净环境里跑。
 *
 * 用法：node test-sticky-pick-child.mjs <port> <label>
 * 输出：最后一行是 JSON（{ modelLine, table }），其余是插件日志（stderr）。
 */

import { createServer } from 'node:http';

const port = Number(process.argv[2]);
const label = process.argv[3] ?? '';
const workdir = process.env.BOTPLUGIN_TEST_CWD;

const sent = [];
const updateQueue = [];

const tg = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const json = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  let params = {};
  try {
    params = JSON.parse(body || '{}');
  } catch {}

  if (url.pathname.includes('/getMe')) {
    return json({ ok: true, result: { id: 999, is_bot: true, username: 'testbot' } });
  }
  if (url.pathname.includes('/getUpdates')) {
    if (updateQueue.length === 0) await new Promise((r) => setTimeout(r, 150));
    return json({ ok: true, result: updateQueue.splice(0, updateQueue.length) });
  }
  if (url.pathname.includes('/sendMessage')) {
    sent.push({ text: params.text ?? '', reply_markup: params.reply_markup });
    return json({ ok: true, result: { message_id: sent.length, chat: { id: params.chat_id } } });
  }
  if (url.pathname.includes('/answerCallbackQuery')) return json({ ok: true, result: true });
  if (url.pathname.includes('/sendChatAction')) return json({ ok: true, result: true });
  return json({ ok: true, result: {} });
});
await new Promise((r) => tg.listen(port, '127.0.0.1', r));

const sessionListeners = [];
const agent = { id: 'botplugin:tg:4242' };
agent.followup = () => {
  setTimeout(() => {
    for (const fn of sessionListeners) {
      fn({ id: agent.id }, { type: 'turn/end', data: { reason: 'completed' } });
    }
  }, 5);
};

// ⚠️ 插件走 `ctx.get('settings')` / `ctx.get('llm')` 取服务（不是 ctx.settings）。
const settingsService = {
  // 刻意不给档位：要验的是记忆位自己能不能活下来，不是 settings 兜底。
  get: () => ({}),
};
const llmService = {
  listProviders: () => [],
  // 内置 deepseek 目录刻意留空：本测试聚焦「pi-ai 表变了」这一维
  //   （内置 ds 段不由 web 端配置决定，是另一条独立缺陷，见 index.js hostModelTable ②）。
  listModels: async () => [],
};
const ctx = {
  agents: { create: async () => ({ agent }) },
  get: (name) => (name === 'settings' ? settingsService : name === 'llm' ? llmService : undefined),
  on: () => {},
};

// 收掉插件日志，别污染 stdout 的 JSON。
const realLog = console.log;
console.log = () => {};

const { apply } = await import('./src/index.js');
apply(ctx, {
  telegramToken: 'TOKEN',
  telegramApiRoot: `http://127.0.0.1:${port}`,
  telegramAllowedUsers: [],
  cwd: workdir,
  turnTimeoutMs: 2000,
});
await new Promise((r) => setTimeout(r, 300));

updateQueue.push({
  update_id: 1,
  message: { message_id: 1, from: { id: 101 }, chat: { id: 101 }, text: '/status' },
});

const deadline = Date.now() + 4000;
let statusMsg;
while (Date.now() < deadline) {
  statusMsg = sent.find((m) => m.text.includes('📊 当前状态'));
  if (statusMsg) break;
  await new Promise((r) => setTimeout(r, 50));
}

const text0 = statusMsg?.text ?? '';
const modelLine = text0.split('\n').find((l) => l.startsWith('模型:')) ?? `(没截到 ${label})`;

// ── 可选：再模拟用户在 /model 菜单里手点一个档位（走真 callback_query 路径）──
// 这是**唯一**该改写记忆位的入口，必须证明它真的还改得动
//   —— 别把"自动不再改"误伤成"手点也改不了"。
const pickKey = process.argv[4];
let afterPick = null;
if (pickKey) {
  // ⚠️ `/status` 是纯文本，不带按钮 —— 要先发 `/model` 才会拿到可选档位菜单。
  sent.length = 0;
  updateQueue.push({
    update_id: 90,
    message: { message_id: 90, from: { id: 101 }, chat: { id: 101 }, text: '/model' },
  });
  const dm = Date.now() + 4000;
  while (Date.now() < dm) {
    if (sent.some((m) => m.reply_markup)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // 从菜单按钮里找到目标档位的 callback_data（不猜 data 格式，直接读插件发出来的）。
  const menu = sent.filter((m) => m.reply_markup).pop();
  const buttons = (menu?.reply_markup?.inline_keyboard ?? []).flat();
  const btn = buttons.find((b) => String(b.callback_data ?? '').includes(pickKey));
  if (!btn) {
    process.stdout.write(
      JSON.stringify({ modelLine, afterPick: null, error: `菜单里没找到 ${pickKey}，按钮=${JSON.stringify(buttons.map((b) => b.callback_data))}` }) + '\n',
    );
    process.exit(0);
  }
  updateQueue.push({
    update_id: 2,
    callback_query: {
      id: 'cb1',
      from: { id: 101 },
      message: { message_id: 1, chat: { id: 101 } },
      data: btn.callback_data,
    },
  });
  const d2 = Date.now() + 4000;
  while (Date.now() < d2) {
    if (sent.some((m) => m.text.includes('✅ 已切换到'))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // 切换后要**再发一次** /status 才能看到新的模型行（上面为了拿菜单清空过 sent）。
  sent.length = 0;
  updateQueue.push({
    update_id: 91,
    message: { message_id: 91, from: { id: 101 }, chat: { id: 101 }, text: '/status' },
  });
  const d3 = Date.now() + 4000;
  while (Date.now() < d3) {
    if (sent.some((m) => m.text.includes('📊 当前状态'))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const after = sent.filter((m) => m.text.includes('📊 当前状态')).pop();
  afterPick = (after?.text ?? '').split('\n').find((l) => l.startsWith('模型:')) ?? '(没截到)';
}

console.log = realLog;
tg.close();

process.stdout.write(JSON.stringify({ modelLine, afterPick }) + '\n');
process.exit(0);

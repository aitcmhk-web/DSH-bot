/**
 * 集成回归：TG 发图 → 插件 apply() 真实入站路径 → DSH。
 *
 * 这是 0.0.11 真正栽跟头的地方，也是本文件存在的唯一理由：
 *   那次的块构造对了、"runtime 也能收块"，但中间的 promptFromHub
 *   只把 msg.text（字符串，内容是占位符 "[图片]"）送下去，
 *   msg.raw.blocks 里的图片块**从头到尾没被用过**。
 *   而当时的测试是复制算法去验的，接线对不对从没被验证 ⇒ 真机一发图就露馅。
 *
 * 本测试不复制任何插件侧逻辑：起假 Telegram API → 走真的 apply()
 *   → 真的长轮询收 update → 真的 handleMessage → 真的 hub
 *   → 拦下最终 agent.followup() 的 message。
 *
 * 跑法：node test-image-e2e.mjs
 */

import { createServer } from 'node:http';

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) failed++;
};

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const TG_PORT = 18947;
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

  if (url.pathname.startsWith('/botTOKEN/getMe')) {
    return json({ ok: true, result: { id: 999, is_bot: true, username: 'testbot' } });
  }
  if (url.pathname.startsWith('/botTOKEN/getUpdates')) {
    const batch = updateQueue.splice(0, updateQueue.length);
    if (batch.length === 0) await new Promise((r) => setTimeout(r, 30));
    return json({ ok: true, result: batch });
  }
  if (url.pathname.startsWith('/botTOKEN/getFile')) {
    return json({ ok: true, result: { file_id: 'f1', file_path: 'photos/1.png' } });
  }
  if (url.pathname.startsWith('/file/botTOKEN/')) {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(PNG_BYTES);
  }
  if (url.pathname.startsWith('/botTOKEN/sendMessage')) {
    sent.push(JSON.parse(body || '{}'));
    return json({ ok: true, result: { message_id: sent.length } });
  }
  if (url.pathname.startsWith('/botTOKEN/')) return json({ ok: true, result: true });
  res.writeHead(404);
  res.end('nope');
});
await new Promise((r) => tg.listen(TG_PORT, '127.0.0.1', r));

const delivered = [];
const storeCalls = [];
const sessionListeners = [];
const agent = { id: 'agent-e2e', followup: () => {}, on() {} };
const attachments = {
  async admitPromptContent(content) {
    storeCalls.push(content);
    let n = 0;
    return content.map((p) =>
      p.type === 'image' ? { type: 'image', attachment: `durable-ref-${n++}` } : p,
    );
  },
};

const ctx = {
  agents: {
    create: async ({ sessionId }) => ({ agent, session: { id: sessionId } }),
    get: (id) => (id === agent.id ? agent : undefined),
    resume: async () => ({ agent }),
  },
  attachments,
  on(evt, fn) {
    if (evt === 'session/event') sessionListeners.push(fn);
  },
};
agent.followup = (m) => {
  delivered.push(m);
  setTimeout(() => {
    for (const fn of sessionListeners) {
      fn({ id: 'botplugin:tg:4242' }, { type: 'turn/end', data: { reason: 'completed' } });
    }
  }, 10);
};

const plugin = await import('./src/index.js');
plugin.apply(ctx, {
  telegramToken: 'TOKEN',
  telegramApiRoot: `http://127.0.0.1:${TG_PORT}`,
  telegramAllowedUsers: [],
  cwd: '/tmp',
  turnTimeoutMs: 4000,
  routes: [{ key: 'k', provider: 'deepseek-official', model: 'deepseek-flash' }],
  defaultRouteKey: 'k',
});

await new Promise((r) => setTimeout(r, 300));

updateQueue.push({
  update_id: 1,
  message: {
    message_id: 11,
    from: { id: 4242, is_bot: false, first_name: 'T' },
    chat: { id: 4242, type: 'private' },
    date: Math.floor(Date.now() / 1000),
    photo: [
      { file_id: 'small', file_unique_id: 'u1', width: 1, height: 1, file_size: 10 },
      { file_id: 'f1', file_unique_id: 'u2', width: 1, height: 1, file_size: 70 },
    ],
  },
});

const deadline = Date.now() + 5000;
while (delivered.length === 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}

ok(delivered.length === 1, `消息已投给 agent（${delivered.length} 条）`);
const blocks = delivered[0]?.content ?? [];
ok(
  blocks.some((b) => b?.type === 'image' && typeof b.attachment === 'string'),
  `图片块活着到 agent 且已换引用：${JSON.stringify(blocks).slice(0, 200)}`,
);
ok(storeCalls.length === 1, `attachments.admitPromptContent 恰好调用一次（${storeCalls.length}）`);
ok(
  !blocks.some((b) => b?.type === 'image' && 'data' in b),
  '没有裸露的 base64 图片块漏到 agent（这正是模型"看不见内容"的原因）',
);
ok(
  !JSON.stringify(blocks).includes('[图片]'),
  '不会只把 "[图片]" 占位符送下去（0.0.11 的真实症状）',
);

tg.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

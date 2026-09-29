/**
 * 回归测试：图片块必须被换成宿主持久化引用，否则模型看不见内容。
 *
 * 为什么要有这个文件：
 *   0.0.11 那次的测试是**复制算法**而非调用真实函数（commit 自己承认了），
 *   结果"接线对不对"从没被真实验证过 —— 用户真机一发图就露馅。
 *   这次改成**直接跑真实 `BotRuntime.prompt()`**，只把宿主（agents/attachments）
 *   换成打桩对象，插件侧一行代码都不复制。
 *
 * 跑法：node botplugin/test-image-admit.mjs
 */

import { BotRuntime } from './src/runtime.js';

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) failed++;
};

/** 一张 1x1 PNG 的真 base64（canonical，能过官方的 canonical 校验）。 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * 造一个假宿主。`attachments` 传 null 表示"宿主没挂附件服务"。
 * admitPromptContent 完全照官方语义：把图片块换成 {type:image, attachment}。
 */
function host({ attachments = 'real' } = {}) {
  const delivered = [];
  const storeCalls = [];
  const agent = { id: 'agent-1', followup: (m) => delivered.push(m), on() {} };
  const store =
    attachments === null
      ? undefined
      : {
          async admitPromptContent(content) {
            storeCalls.push(content);
            let n = 0;
            return content.map((p) =>
              p.type === 'image' ? { type: 'image', attachment: `ref-${n++}` } : p,
            );
          },
        };
  const ctx = {
    agents: {
      create: async () => ({ agent }),
      get: (id) => (id === agent.id ? agent : undefined),
      resume: async () => ({ agent }),
    },
    on() {},
    ...(store ? { attachments: store } : {}),
  };
  return { ctx, delivered, storeCalls };
}

const ROUTE = { provider: 'deepseek-official', model: 'deepseek-flash', key: 'k' };

// ── ① 有图：必须换成 attachment，且投出去的消息里没有裸露的 base64 ──
{
  const h = host();
  const rt = new BotRuntime({ ctx: h.ctx, route: ROUTE });
  const res = await rt.prompt('tg:1', [
    { type: 'text', text: '看这张图' },
    { type: 'image', data: PNG, mimeType: 'image/png' },
  ]);

  ok(res.ok === true, `prompt 成功（${res.ok ? 'ok' : res.error}）`);
  ok(h.storeCalls.length === 1, '有图片块 → 恰好调用一次 admitPromptContent');
  const blocks = h.delivered[0]?.content ?? [];
  ok(blocks[0]?.type === 'text' && blocks[0].text === '看这张图', '文本块原样保留、顺序不变');
  ok(
    blocks[1]?.type === 'image' && typeof blocks[1].attachment === 'string',
    `图片块已变成 {type:image, attachment:...}（实际 ${JSON.stringify(blocks[1])}）`,
  );
  ok(!('data' in (blocks[1] ?? {})), '裸 base64 字段已消失（不会再被静默丢掉）');
}

// ── ② 纯文本：一次存储都不该发生 ──────────────────────────────────
{
  const h = host();
  const rt = new BotRuntime({ ctx: h.ctx, route: ROUTE });
  await rt.prompt('tg:2', '只有文字');
  ok(h.storeCalls.length === 0, '纯文本消息完全不碰 attachments（零副作用）');
}

// ── ③ 宿主没挂附件服务：必须**报错**，不许静默放行一张空图 ──────────
{
  const h = host({ attachments: null });
  const rt = new BotRuntime({ ctx: h.ctx, route: ROUTE });
  const res = await rt.prompt('tg:3', [{ type: 'image', data: PNG, mimeType: 'image/png' }]);
  ok(res.ok === false, '拿不到 attachments 时 prompt 明确失败（而不是假装成功）');
  ok(
    String(res.error ?? '').includes('attachments'),
    `失败原因指向 attachments（实际：${res.error}）`,
  );
  ok(h.delivered.length === 0, '失败时消息没有投给 agent（不留半条坏消息）');
}

// ── ④ 真 store 存在性：官方两个入口都在（我们优先走 admitPromptContent）──
{
  const { readFile } = await import('node:fs/promises');
  const p =
    '/Users/tcm/.dsh/profiles/node_modules/@deepseek-ai/dsh-attachment/lib/index.js';
  const src = await readFile(p, 'utf8').catch(() => '');
  ok(src.length > 0, '官方 dsh-attachment 包在本机可读');
  ok(src.includes('async admitPromptContent'), '官方 store 确实提供 admitPromptContent（我们优先走的那条）');
  ok(src.includes('async function admitEncodedImages'), '官方另有 admitEncodedImages（我们兜底用的那条）');
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

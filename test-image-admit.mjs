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

// ── ⓪ 真机暴露的两个契约，先用静态断言钉死 ────────────────────────
//
// 这两条都是 2026-09-29 真机日志抓出来的，打桩测试当时**完全没覆盖**：
//   19:56:18 `cannot get property "attachments" without inject`
//            → Cordis 属性访问受 inject 门禁，没声明就直接抛。
//   20:09:16 `Image type undefined is not accepted by this deployment.`
//            → 宿主 saveInput 只读 `mediaType`，写 `mimeType` 等于传 undefined。
{
  const { readFile } = await import('node:fs/promises');
  const idx = await readFile(new URL('./src/index.js', import.meta.url), 'utf8');
  const m = idx.match(/export const inject\s*=\s*\[([^\]]*)\]/);
  const inject = m ? m[1] : '';
  ok(/\battachments\b/.test(inject), `index.js 声明了 attachments 依赖（inject = [${inject.trim()}]）`);

  // 图片块构造处必须写 mediaType（不能是 mimeType）。
  const push = idx.match(/blocks\.push\(\{\s*type:\s*'image'[\s\S]{0,200}?\}\)/);
  const body = push ? push[0] : '';
  ok(/\bmediaType:/.test(body), '图片块用 mediaType 传类型（宿主只认这个字段名）');
  ok(!/\bmimeType:/.test(body), `图片块没有 mimeType 字段（实际片段：${body.replace(/\s+/g, ' ').slice(0, 80)}）`);
}

// ── ① 有图：必须换成 attachment，且投出去的消息里没有裸露的 base64 ──
{
  const h = host();
  const rt = new BotRuntime({ ctx: h.ctx, route: ROUTE });
  const res = await rt.prompt('tg:1', [
    { type: 'text', text: '看这张图' },
    { type: 'image', data: PNG, mediaType: 'image/png' },
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
  const res = await rt.prompt('tg:3', [{ type: 'image', data: PNG, mediaType: 'image/png' }]);
  ok(res.ok === false, '拿不到 attachments 时 prompt 明确失败（而不是假装成功）');
  ok(
    String(res.error ?? '').includes('attachments'),
    `失败原因指向 attachments（实际：${res.error}）`,
  );
  ok(h.delivered.length === 0, '失败时消息没有投给 agent（不留半条坏消息）');
}

// ── ④ 属性被 inject 门禁挡住时，必须还能从 ctx.get() 兜底拿到服务 ──
//    模拟真机 19:56:18：`ctx.attachments` 抛错而不是返回 undefined。
{
  const h = host();
  const store = h.ctx.attachments;
  const gated = {
    get agents() {
      return h.ctx.agents;
    },
    get attachments() {
      throw new Error('cannot get property "attachments" without inject');
    },
    get: (name) => (name === 'attachments' ? store : undefined),
    on() {},
  };
  const rt = new BotRuntime({ ctx: gated, route: ROUTE });
  const res = await rt.prompt('tg:4', [{ type: 'image', data: PNG, mediaType: 'image/png' }]);
  ok(res.ok === true, `属性被 inject 挡住时仍能成功（${res.ok ? 'ok' : res.error}）`);
  const gb = h.delivered[0]?.content ?? [];
  ok(gb[0]?.type === 'image' && typeof gb[0].attachment === 'string', '兜底拿到的服务确实完成了转换');
}

// ── ⑤ 真 store 存在性：官方两个入口都在（我们优先走 admitPromptContent）──
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

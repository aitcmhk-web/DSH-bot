/**
 * 图片块通道回归测试。
 *
 * 验的是 promptFromHub 里那段「有块走块、没块走文本」的组装逻辑。
 * ⚠️ 这里**复制**了 index.js 的组装代码，不是 import —— promptFromHub 是闭包内的
 *    函数，拿不到。所以本测试只证明**算法正确**；「接进真实调用点」由 diff 复核保证。
 *    两处若将来改了一处忘另一处，本测试会失效 —— 它盯的是逻辑，不是接线。
 */

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

/** 被测逻辑：从 index.js promptFromHub 原样抄来。 */
function assemble({ text, blocks, bootPrefix }) {
  const promptText = `${bootPrefix}${text}`;
  let promptContent = promptText;
  if (blocks) {
    promptContent = blocks.map((b) => (b?.type === 'text' && typeof b.text === 'string'
      ? { ...b, text: `${bootPrefix}${b.text}` }
      : { ...b }));
    if (bootPrefix && !blocks.some((b) => b?.type === 'text' && typeof b.text === 'string')) {
      promptContent.unshift({ type: 'text', text: `${bootPrefix}${text}`.trim() });
    }
  }
  return { promptText, promptContent };
}

const IMG = { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' };

console.log('\n[1] 纯文字（无块）→ 行为必须与改动前完全一致');
{
  const r = assemble({ text: '你好', blocks: null, bootPrefix: '' });
  ok('走字符串路径', r.promptContent === '你好');
}

console.log('\n[2] 图 + 文字（TG 实际形态：text 块在前，image 块在后）');
{
  const r = assemble({ text: '这是什么', blocks: [{ type: 'text', text: '这是什么' }, IMG], bootPrefix: '' });
  ok('投递的是数组，不是 "[图片]" 字符串', Array.isArray(r.promptContent));
  ok('块数为 2', r.promptContent.length === 2, `实际 ${r.promptContent.length}`);
  ok('第 1 块是文字且内容原样', r.promptContent[0].type === 'text' && r.promptContent[0].text === '这是什么');
  ok('第 2 块是图片且 base64 保真', r.promptContent[1].type === 'image' && r.promptContent[1].data === 'AAAA');
  ok('没有 "[图片]" 字面量泄漏', !JSON.stringify(r.promptContent).includes('[图片]'));
}

console.log('\n[3] 纯图无文字');
{
  const r = assemble({ text: '[图片]', blocks: [IMG], bootPrefix: '' });
  ok('投递数组且只含图片块', Array.isArray(r.promptContent) && r.promptContent.length === 1 && r.promptContent[0].type === 'image');
}

console.log('\n[4] 带冷启动记忆前言（最容易出错的一条：前言不能丢）');
{
  const boot = '<冷启动记忆>…</冷启动记忆>\n\n';
  const r = assemble({ text: '这是什么', blocks: [{ type: 'text', text: '这是什么' }, IMG], bootPrefix: boot });
  ok('前言进了第一个 text 块', r.promptContent[0].text.startsWith('<冷启动记忆>'));
  ok('前言只出现一次', r.promptContent.filter((b) => JSON.stringify(b).includes('冷启动记忆')).length === 1);
  ok('原文跟在前提之后', r.promptContent[0].text.endsWith('这是什么'));
  ok('图片块未被动过', r.promptContent[1].type === 'image' && r.promptContent[1].data === 'AAAA');
}
{
  const boot = '<冷启动记忆>…</冷启动记忆>\n\n';
  const r = assemble({ text: '[图片]', blocks: [IMG], bootPrefix: boot });
  ok('纯图 + 前言 → 补出文字块顶在最前', r.promptContent[0].type === 'text' && r.promptContent[0].text.startsWith('<冷启动记忆>'));
  ok('图片块仍为第 2 块', r.promptContent[1].type === 'image');
}

console.log('\n[5] 原始 raw.blocks 不被原地修改（host 会深冻结，改它=炸）');
{
  const original = [{ type: 'text', text: '原话' }, IMG];
  const snapshot = JSON.stringify(original);
  const boot = '<冷启动记忆>…</冷启动记忆>\n\n';
  assemble({ text: '原话', blocks: original, bootPrefix: boot });
  ok('raw.blocks 一个字节没变', JSON.stringify(original) === snapshot);
  ok('返回的是新对象', assemble({ text: '原话', blocks: original, bootPrefix: '' }).promptContent[0] !== original[0]);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);

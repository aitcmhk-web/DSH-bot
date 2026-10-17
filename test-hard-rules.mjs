/**
 * test-hard-rules.mjs —— hard-rules（最高指令 + 教训钩子）回归测试。
 *
 * 在临时目录里模拟「插件被装进 node_modules」：把 src/hard-rules.js 与包根
 * HARD-RULES.md 拷进 <tmp>/node_modules/dsh-botplugin/，再从那儿 import ——
 * 证明规则文本是按模块的相对位置找到的，不依赖仓库路径或任何绝对路径。
 *
 * 覆盖：
 *   ① agent/pre-step 第 1 步注入，正文 = 包内 HARD-RULES.md；
 *   ② 之后每 N 步才注入（第 2 步不注）；
 *   ③ tools/post-execute 命中失败特征 → 教训正文从工作区 lessons-bot.md 现读；
 *   ④ 同一特征进程内只顶一次；
 *   ⑤ 「读/搜类命令」不触发（防 grep 自己的输出把自己骗一遍）。
 *
 * 跑法：node test-hard-rules.mjs
 */

import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 仓库根（本测试文件所在目录）。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** 用例失败只标记失败，跑完全部用例再退出 —— 一次看全哪儿红了。 */
let failed = 0;
const check = (cond, msg) => {
  if (cond) {
    console.log(`✅ ${msg}`);
  } else {
    console.error(`❌ ${msg}`);
    failed += 1;
  }
};

const TMP = mkdtempSync(join(tmpdir(), 'hardrules-test-'));
try {
  const pkg = join(TMP, 'node_modules', 'dsh-botplugin');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  cpSync(join(HERE, 'HARD-RULES.md'), join(pkg, 'HARD-RULES.md'));
  cpSync(join(HERE, 'src', 'hard-rules.js'), join(pkg, 'src', 'hard-rules.js'));
  mkdirSync(join(TMP, 'ws', 'memory'), { recursive: true });
  writeFileSync(
    join(TMP, 'ws', 'memory', 'lessons-bot.md'),
    '## 第 8 条 · 测试教训\n这是第 8 条的正文。\n\n## 第 9 条 · 别的\n别的正文。\n',
  );

  const { installHardRules } = await import(pathToFileURL(join(pkg, 'src', 'hard-rules.js')).href);
  /** 假 ctx：只收事件监听器。 */
  const handlers = {};
  installHardRules(
    { on(event, fn) { handlers[event] = fn; } },
    { cwd: join(TMP, 'ws'), hitLog: join(TMP, 'hits.log') },
  );

  const pkgRules = readFileSync(join(pkg, 'HARD-RULES.md'), 'utf8').trim();
  const preStep = handlers['agent/pre-step'];
  const postExec = handlers['tools/post-execute'];
  check(typeof preStep === 'function' && typeof postExec === 'function', '两个挂载点都挂上了');

  // ① 第 1 步：注入，正文来自包内规则文件
  const payload = { messages: [{ id: 'u1' }] };
  const d1 = await preStep(payload, () => ({ kind: 'enter', messages: [{ id: 'u1' }] }));
  check(d1?.kind === 'enter' && d1.messages.length === 2, '第 1 步追加了一条规则消息');
  check(
    d1?.messages?.[1]?.content?.[0]?.text === pkgRules && pkgRules.includes('最高指令'),
    '注入正文 = 包内 HARD-RULES.md（按模块相对位置解析）',
  );

  // ② 第 2 步：不注（默认每 10 步）
  const d2 = await preStep({ messages: [] }, () => ({ kind: 'enter', messages: [] }));
  check(d2.messages.length === 0, '第 2 步不重复注入');

  // ③ 命中失败特征 → 现读工作区教训档
  const hit = postExec(
    { name: 'bash', arguments: { command: 'node send.mjs' } },
    { content: [{ type: 'text', text: 'HTTP 409 Conflict: terminated by other getUpdates' }] },
    () => 'NEXT',
  );
  const body = hit?.additionalContexts?.[0]?.content?.[0]?.text ?? '';
  check(hit?.kind === 'accept' && body.includes('409'), '命中 409 时返回 additionalContexts');
  check(body.includes('教训档 第 8 条') && body.includes('这是第 8 条的正文'), '教训正文从工作区 lessons-bot.md 现读');

  // ④ 同一特征只顶一次
  const again = postExec(
    { name: 'bash', arguments: { command: 'node send.mjs' } },
    { content: [{ type: 'text', text: '409 Conflict' }] },
    () => 'NEXT2',
  );
  check(again === 'NEXT2', '同一特征第二次不再注入');

  // ⑤ 读/搜类命令不触发（否则会拿自己 grep 出来的特征骗自己）
  const readonly = postExec(
    { name: 'bash', arguments: { command: 'grep -n 409 memory/lessons-bot.md' } },
    { content: [{ type: 'text', text: '409 Conflict' }] },
    () => 'NEXT3',
  );
  check(readonly === 'NEXT3', '读/搜类命令不触发教训钩子');
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} 条用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
// test-progress-notes.mjs — 进度消息「只显示正在做什么」的自测（离线，不碰网络 / DSH / 真会话）
//
// 跑法：node test-progress-notes.mjs
//
// 覆盖（2026-10-18 口径：进度只回答「我正在做什么」，思考与操作细节不上屏）：
//   ① 正文里只挑 `[进度] …` 标记行（全半角括号都认），其余正文一律不挑
//   ② 没有标记的一整段思考（中英夹杂）→ 一条动态都不产生
//   ③ 进度行掐到 120 字、空标记丢掉
//   ④ 工具只出中文动作标签：给了命令／路径／搜索词也不带出来
//   ⑤ 认不出的工具给「🔧 名字」，不炸
//   ⑥ addNote：进度行带 📌、连着两条一样的不重复、只留最近 12 条
//   ⑦ render：只上屏最近 3 条，头部仍是「⏳ 正在处理… (Ns)」
//   ⑧ `DSH_BOTPLUGIN_PROGRESS_TOOLS=0` 时工具标签不上屏（子进程验，因开关在模块加载时读）
//
// 环境：只在本文件内构造 LiveStatus（messageId 为空 → 不排编辑、不碰 Telegram）。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { LiveStatus, describeTool, 挑进度行 } from './src/status.js';

let 过 = 0;
const 断言 = (条件, 说明) => {
  assert.ok(条件, 说明);
  过 += 1;
  console.log(`  ✓ ${说明}`);
};

console.log('① 只挑 `[进度] …` 标记行');
{
  const 文 = [
    '我先看一下这几个文件。',
    '[进度] 正在核对建表脚本',
    'Thinking: check the schema… 让我读一下 建表.sql',
    '【进度】正在跑自测',
    '［进度］  正在写迁移脚本  ',
    '结论：干完了。',
  ].join('\n');
  const 行 = 挑进度行(文);
  断言(行.length === 3, `挑出 3 条进度行（实得 ${行.length}）`);
  断言(行[0] === '正在核对建表脚本', '第一条正文正确');
  断言(行[1] === '正在跑自测', '全角【进度】也认');
  断言(行[2] === '正在写迁移脚本', '全角［进度］＋多余空白已收敛');
}

console.log('② 没有标记的思考段落 → 零动态');
{
  断言(挑进度行('Let me think about #1 and 2…\n先看现状再说。').length === 0, '无标记时一条不挑');
  断言(挑进度行('').length === 0 && 挑进度行(null).length === 0, '空值与 null 不炸');
  断言(挑进度行('[进度]').length === 0 && 挑进度行('[进度]   ').length === 0, '只有标记没内容 → 丢掉');
}

console.log('③ 单条掐到 120 字');
{
  const 长 = `[进度] ${'字'.repeat(300)}`;
  const 行 = 挑进度行(长);
  断言(行.length === 1 && 行[0].length === 120, '长行掐到 120 字');
}

console.log('④ 工具行＝动作标签：具体在干什么（真命令／真文件名）');
{
  const 标 = describeTool('bash', { command: 'grep -rn notes src/index.js' });
  断言(标 === '💻 跑命令：grep -rn notes src/index.js', `bash → ${标}`);
  断言(describeTool('bash', JSON.stringify({ command: 'ls -la\ncd /tmp' })) === '💻 跑命令：ls -la', 'JSON 串入参与多行命令取首行');
  断言(describeTool('read', { file_path: '/Users/tcm/DSH/dshbot/建表.sql' }) === '📖 看文件：建表.sql', 'read 只留文件名');
  断言(describeTool('edit', { file_path: 'a/b/c/服务.mjs' }) === '✏️ 改文件：服务.mjs', 'edit 只留文件名');
  断言(describeTool('write', { file_path: '/x/y.md' }) === '📝 写文件：y.md', 'write 只留文件名');
  断言(describeTool('grep', { pattern: 'prescriptions' }) === '🔍 搜索内容：prescriptions', 'grep 带搜索词');
  断言(describeTool('glob', { pattern: '**/*.md' }) === '🔍 查找文件：**/*.md', 'glob 带模式');
  断言(describeTool('web_fetch', { url: 'https://example.com/a' }).includes('example.com'), 'web_fetch 带网址');
  断言(describeTool('web_search', { queries: ['口径整改'] }).endsWith('口径整改'), 'web_search 带首个搜索词');
  断言(describeTool('subagent', { description: '查文档' }).endsWith('查文档'), 'subagent 带任务名');
}

console.log('⑤ 口令打码、抠不出细节就只留标签');
{
  const 标 = describeTool('bash', { command: 'PGPASSWORD=aitcm_dev_pw psql -h x' });
  断言(!标.includes('aitcm_dev_pw'), `口令不进进度行 → ${标}`);
  断言(标.includes('PGPASSWORD=***'), '口令位换成 ***，仍看得出在连库');
  断言(!describeTool('bash', { command: 'curl -H "Authorization: Bearer abc123" u' }).includes('abc123'), 'Bearer 票也打码');
  断言(describeTool('bash', {}) === '💻 跑命令', '没命令就只留标签，⛔ 不编占位词');
  断言(describeTool('bash', '{坏JSON') === '💻 跑命令', '入参解析不出也不炸');
  断言(describeTool('todo_write', { todos: [] }) === '📋 更新任务清单', '没有可显示的细节就只留标签');
  断言(describeTool('some_new_tool') === '🔧 some_new_tool', '原样给名字');
  断言(describeTool(undefined) === '🔧 工具', '名字缺了也给个不含糊的标签');
}

console.log('⑥ addNote 口径');
{
  const s = new LiveStatus({ kind: 'tg' });
  s.addNote('正在改建表脚本', '进度');
  s.addNote('正在改建表脚本', '进度');   // 连着重复：不重复上屏
  s.addNote('💻 跑命令：ls -la', '工具');
  断言(s.notes.length === 2, `连着重复只留一条（实得 ${s.notes.length}）`);
  断言(s.notes[0] === '📌 正在改建表脚本', '进度行带 📌');
  断言(s.notes[1] === '💻 跑命令：ls -la', '工具行原样（标签＋细节）');
  for (let i = 0; i < 20; i += 1) s.addNote(`第 ${i} 步`, '进度');
  断言(s.notes.length === 12, '最多留 12 条');
}

console.log('⑦ render 只上屏最近 3 条');
{
  const s = new LiveStatus({ kind: 'tg' });
  s.addNote('第一步', '进度');
  s.addNote('第二步', '进度');
  s.addNote('第三步', '进度');
  s.addNote('第四步', '进度');
  const 文 = s.render();
  断言(文.startsWith('⏳ 正在处理…'), '头部仍是占位语＋已耗时');
  断言(!文.includes('第一步') && 文.includes('第二步'), '滚出去的不再显示');
  断言(文.split('\n').filter((l) => l.startsWith('📌')).length === 3, '上屏 3 条进度行');
  断言(new LiveStatus({ kind: 'tg' }).render() === '⏳ 正在处理… (0s)', '没有动态时只有头部');
}

console.log('⑧ DSH_BOTPLUGIN_PROGRESS_TOOLS=0 时工具标签不上屏');
{
  const 码 = `
    import { LiveStatus } from './src/status.js';
    const s = new LiveStatus({ kind: 'tg' });
    s.addNote('正在改建表脚本', '进度');
    s.addNote('💻 跑命令：ls -la', '工具');
    if (s.notes.length !== 1 || !s.notes[0].startsWith('📌')) { console.error('FAIL', JSON.stringify(s.notes)); process.exit(1); }
    console.log('OK');
  `;
  const 出 = execFileSync(process.execPath, ['--input-type=module', '-e', 码], {
    env: { ...process.env, DSH_BOTPLUGIN_PROGRESS_TOOLS: '0' }, encoding: 'utf8',
  }).trim();
  断言(出 === 'OK', '开关关掉后只剩进度行');
}

console.log(`\n全部通过：${过} 项`);
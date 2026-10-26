// test-反馈区.mjs — src/反馈区.js 的回归（离线：临时目录 + 假注入，不碰真会话、不起真进程）。
//
// 覆盖：① 第一次只记基线、不注入；② 改一个文件 → 注入一次、话里带目录名；
// ③ 没变 → 不重复注入；④ .备份 / 原始 / node_modules 不算变化；
// ⑤ 注入失败 → 状态不推进，下一拍重投；⑥ 目录不在 → 跳过且不抛。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFeedbackWatch } from './src/反馈区.js';

const 造 = () => {
  const 根 = mkdtempSync(join(tmpdir(), 'dsh-反馈区-'));
  const 盯 = join(根, '反馈区');
  mkdirSync(盯, { recursive: true });
  writeFileSync(join(盯, '问题清单.md'), '第一版');
  mkdirSync(join(盯, '.备份'), { recursive: true });
  writeFileSync(join(盯, '.备份', '旧.md'), '备份');
  return { 根, 盯 };
};

test('① 第一次只记基线、不注入', async () => {
  const { 根, 盯 } = 造();
  const 注入 = [];
  const w = createFeedbackWatch({
    dirs: [{ 名称: '主bot反馈区', 目录: 盯 }],
    statePath: join(根, '状态.json'),
    lockPath: join(根, '.lock'),
    chatId: () => 111,
    inject: async (id, 话) => { 注入.push({ id, 话 }); },
  });
  await w.tick();
  assert.equal(注入.length, 0, '基线那一拍不该注入');
  assert.ok(readFileSync(join(根, '状态.json'), 'utf8').includes('主bot反馈区'));
  rmSync(根, { recursive: true, force: true });
});

test('② 改文件 → 注入一次；③ 没变 → 不重复；④ 备份目录不算', async () => {
  const { 根, 盯 } = 造();
  const 注入 = [];
  const w = createFeedbackWatch({
    dirs: [{ 名称: '主bot反馈区', 目录: 盯 }],
    statePath: join(根, '状态.json'),
    lockPath: join(根, '.lock'),
    chatId: () => 111,
    inject: async (id, 话) => { 注入.push({ id, 话 }); },
  });
  await w.tick(); // 基线
  writeFileSync(join(盯, '问题清单.md'), '第二版');
  await w.tick();
  assert.equal(注入.length, 1);
  assert.equal(注入[0].id, 111);
  assert.match(注入[0].话, /主bot反馈区/);
  assert.match(注入[0].话, /反馈区有更新/);

  await w.tick(); // 没变
  assert.equal(注入.length, 1, '没变不该再叫');

  writeFileSync(join(盯, '.备份', '旧.md'), '备份改了'); // 备份目录不参与
  await w.tick();
  assert.equal(注入.length, 1, '备份目录的变化不该叫');
  rmSync(根, { recursive: true, force: true });
});

test('⑤ 注入失败 → 状态不推进，下一拍重投', async () => {
  const { 根, 盯 } = 造();
  let 次 = 0;
  const 注入 = [];
  const w = createFeedbackWatch({
    dirs: [{ 名称: '我的修复区', 目录: 盯 }],
    statePath: join(根, '状态.json'),
    lockPath: join(根, '.lock'),
    chatId: () => 111,
    inject: async (id, 话) => {
      次 += 1;
      if (次 === 1) throw new Error('注入腿断了');
      注入.push(话);
    },
    error: () => {},
  });
  await w.tick();
  writeFileSync(join(盯, '问题清单.md'), '第二版');
  await w.tick(); // 这次注入失败
  assert.equal(注入.length, 0);
  await w.tick(); // 重投成功
  assert.equal(注入.length, 1, '失败那一拍不推进状态，下一拍要重投');
  rmSync(根, { recursive: true, force: true });
});

test('⑥ 目录不在 → 跳过且不抛', async () => {
  const { 根 } = 造();
  const w = createFeedbackWatch({
    dirs: [{ 名称: '不存在的区', 目录: join(根, '没有这个目录') }],
    statePath: join(根, '状态.json'),
    lockPath: join(根, '.lock'),
    chatId: () => 111,
    inject: async () => { throw new Error('不该注入'); },
    log: () => {},
  });
  await w.tick();
  await w.tick();
  rmSync(根, { recursive: true, force: true });
});

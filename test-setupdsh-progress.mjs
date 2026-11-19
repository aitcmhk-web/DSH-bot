/**
 * test-setupdsh-progress.mjs —— /setupdsh 三条状态回报的回归测试。
 * 用假 helper 驱动，不跑真升级。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'setupdsh-progress-'));
process.env.HOME = home;

const { runSetupdshUpgrade, isSetupdshRunning } = await import('./src/setupdsh-progress.js');

const helper = join(home, 'fake-helper.sh');

async function waitDone(timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (isSetupdshRunning()) {
    if (Date.now() > until) throw new Error('升级状态没有结束');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function runCase(script, expectFail) {
  writeFileSync(helper, script);
  chmodSync(helper, 0o755);
  const messages = [];
  await runSetupdshUpgrade({
    helper,
    reply: async (text) => { messages.push(String(text)); },
    log: () => {},
    error: (text) => { throw new Error(String(text)); },
  });
  await waitDone();
  assert.equal(messages.length, 3, `应只回三条，实际 ${messages.length}：\n${messages.join('\n---\n')}`);
  assert.match(messages[0], /^DSH：/);
  assert.match(messages[1], /^dshbot 插件：/);
  assert.match(messages[2], expectFail ? /^❌ 升级失败：/ : /^✅ 升级完成：/);
  assert.match(messages[2], /DSH：/);
  assert.match(messages[2], /dshbot 插件：/);
  return messages;
}

try {
  const ok = await runCase(`#!/bin/bash
echo "✅ dsh：0.2.2-rc.5  （/usr/local/bin/dsh）"
echo ""
echo "把已经装了机器人的工作区里的插件，一起升到最新…"
echo "✅ 工作区 dshbot 的插件：1.1.15 → 1.1.16"
echo ""
echo "============ 机器环境安装完成 ============"
exit 0
`, false);

  const fail = await runCase(`#!/bin/bash
echo "当前 dsh：0.2.2-rc.5"
echo "⚠️ dsh 没升成（大概是没网），现在还是：0.2.2-rc.5"
exit 2
`, true);

  console.log('✅ test-setupdsh-progress 4/4 通过');
  console.log('成功样例：\n' + ok.join('\n---\n'));
  console.log('失败样例：\n' + fail.join('\n---\n'));
} finally {
  rmSync(home, { recursive: true, force: true });
}

/**
 * test-systemd-unit-repair.mjs —— setupdsh 的 unit 修复逻辑回归测试。
 *
 * 覆盖：老 unit 的 `Restart=on-failure` 被改成 `always`（dsh 吃 SIGTERM 是干净退出，
 * on-failure 下 systemd 不拉，一次 /restart 之后 bot 就一直躺着）；
 * 已经是 always 的不动、不备份；原来在跑的重新拉，没跑的不动。
 *
 * 从 setupdsh.sh 抽真函数跑，systemctl 用 shell 假函数顶替（记录调用），
 * SYSTEMD_UNIT_DIR 指到临时目录 —— 不碰真的 /etc/systemd/system。
 *
 * 跑法：node test-systemd-unit-repair.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'setupdsh.sh'), 'utf8');
const FN = /^repair_systemd_units\(\)[\s\S]*?\n\}\n/m.exec(SRC)?.[0];
if (!FN) {
  console.error('❌ 从 setupdsh.sh 抽不到 repair_systemd_units —— 函数名或结构变了');
  process.exit(1);
}

const UNIT_BOT = (restart) => `[Unit]\nDescription=x\n\n[Service]\nExecStart=/usr/bin/dsh --profile mybot\n${restart}\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n`;

let failed = 0;
const check = (cond, msg) => {
  if (cond) {
    console.log(`✅ ${msg}`);
  } else {
    console.error(`❌ ${msg}`);
    failed += 1;
  }
};

const TMP = mkdtempSync(join(tmpdir(), 'unit-repair-'));
try {
  const units = join(TMP, 'units');
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, 'dsh-bot-mybot.service'), UNIT_BOT('Restart=on-failure'));
  writeFileSync(join(units, 'dsh-bot-other.service'), UNIT_BOT('Restart=on-failure'));
  writeFileSync(join(units, 'dsh-web.service'), UNIT_BOT('Restart=always'));
  writeFileSync(join(units, 'unrelated.service'), UNIT_BOT('Restart=on-failure'));

  const calls = join(TMP, 'calls.log');
  const harness = join(TMP, 'harness.sh');
  writeFileSync(harness, `say() { echo "$@"; }
# 假 systemctl：只把 dsh-bot-mybot 当「在跑」，其余 inactive
systemctl() {
  echo "$*" >> "$CALLS"
  case "$1" in
    is-active)
      for a in "$@"; do case "$a" in --quiet) ;; *) SVC="$a" ;; esac; done
      case "$SVC" in dsh-bot-mybot) return 0 ;; *) return 3 ;; esac ;;
    *) return 0 ;;
  esac
}
SYSTEMD_UNIT_DIR="$UNITS"
${FN}
repair_systemd_units
`);

  execFileSync('sh', [harness], {
    env: { ...process.env, UNITS: units, CALLS: calls },
    stdio: 'pipe',
  });

  const read = (f) => readFileSync(join(units, f), 'utf8');
  const log = readFileSync(calls, 'utf8');

  check(/^Restart=always$/m.test(read('dsh-bot-mybot.service')), 'on-failure 的 bot unit 被改成 always');
  check(readdirSync(units).some((n) => n.startsWith('dsh-bot-mybot.service.bak-restart-always-')), '改过的 unit 落了备份');
  check(/^Restart=always$/m.test(read('dsh-bot-other.service')), '另一个 on-failure 的 bot unit 也改了');
  check(read('dsh-web.service') === UNIT_BOT('Restart=always'), '已经是 always 的 web unit 一字不动');
  check(!readdirSync(units).some((n) => n.startsWith('dsh-web.service.bak')), '没改的 unit 不产生备份');
  check(read('unrelated.service').includes('Restart=on-failure'), '不匹配 dsh-bot-*/dsh-web 的 unit 不碰');
  check(/^restart dsh-bot-mybot$/m.test(log), '原来在跑的 unit 改完被重新拉起');
  check(!/^restart dsh-bot-other$/m.test(log), '没在跑的 unit 不替用户拉起');
  check(/daemon-reload/.test(log), '改完跑了 daemon-reload');
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} 条用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
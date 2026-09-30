/**
 * 回归：用户手选的档位必须「粘」住 —— 不管什么原因都不许自动切回第一档。
 *
 * 用户定案（2026-09-30）：「不要自动切换回第一档，除非我手动切换，不管什么原因」，
 *   「不管什么」= 重启 bot / 重启电脑 / 升级后重启（**不含**模型欠费那种自动换档，
 *   那是另一码事，本测试不涉及）。
 *
 * 历次根因：refreshHostRoute() 拿「这个 key 在不在当前档位表里」当记忆位的存活判据。
 *   表是每次实时重建的（web 端 patch + 内置 deepseek 目录），任何变动都会让手选档
 *   一时匹配不上 → 被判死 + 落盘清空 → 重启后回第一档。
 *
 * 本测试走真 apply() + 真长轮询 + 真 handleCommand，不复制插件逻辑。
 * 用 3 个场景覆盖「表变了」的三种典型形态：
 *   ① 表里完全没有那条档（web 端读不到表 → 空表）
 *   ② 表里没有那条档，但**别的**档还在（用户从 web 端删了它）
 *   ③ 表整体换了一批（升级 / profile 重建，档名全变）
 * 三种都要求：**仍然用手选档**，且 .botplugin-state.json 里的 key 不被抹掉。
 *
 * 跑法：node test-sticky-pick.mjs
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failed = 0;
// ⚠️ 走 stderr：下面会临时接管 console.log 收插件日志，用 console.log 报结果会被吞。
const ok = (cond, msg) => {
  process.stderr.write(`${cond ? '✅' : '❌'} ${msg}\n`);
  if (!cond) failed++;
};

// ⚠️ 必须用临时 cwd：单实例锁与记忆文件都落在 cwd，占 cwd 会写进真身 bot.js 目录。
const WORKDIR = mkdtempSync(join(tmpdir(), 'botplugin-stickypick-'));
const STATE_FILE = join(WORKDIR, '.botplugin-state.json');

const PICKED = 'zhipu:glm-4.7-flash';
// 用户手选的档先落盘 —— 模拟「上次会话手切过，然后重启」。
writeFileSync(STATE_FILE, JSON.stringify({ hostPickedKey: PICKED }, null, 2));

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * 起一个假宿主 + 假 Telegram，跑真 apply()，发 /status 截下真实文本。
 *
 * ⚠️ 两个隔离点，少一个测试就是假的（本次都踩过）：
 *   1. 插件走 `ctx.get('settings')` 取服务，不是 `ctx.settings` —— 写错等于真实路径
 *      根本没被走到，新旧代码都会"通过"。
 *   2. 插件**自己读文件** `~/.dsh/profiles/web/cordis.patch.yml` 拿 web 端档位表
 *      （web-patch.js），所以必须用子进程 + 改 `HOME` 把它引到假 home，
 *      否则读到的是本机真表，场景 ①②③ 就都测不到"表变了"。
 *
 * @param {object} opts
 * @param {number} opts.port      假 TG 端口
 * @param {object|null} opts.providers 这一轮 web 端 patch 里的 providers（null = 不给 patch 文件）
 * @param {string} opts.label
 */
async function runScenario({ port, providers, label, pickKey }) {
  // 每个场景一个假 home：patch 写在这里，插件只会看到这里。
  const home = mkdtempSync(join(tmpdir(), 'fakehome-'));
  if (providers) {
    const dir = join(home, '.dsh', 'profiles', 'web');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cordis.patch.yml'), renderPatch(providers));
  }

  const runner = new URL('./test-sticky-pick-child.mjs', import.meta.url);

  const args = [runner.pathname, String(port), label];
  if (pickKey) args.push(pickKey);
  const r = spawnSync(process.execPath, args, {
    env: { ...process.env, HOME: home, BOTPLUGIN_TEST_CWD: WORKDIR },
    encoding: 'utf8',
  });
  rmSync(home, { recursive: true, force: true });

  // 子进程把结论打成 JSON 走 stdout，日志走 stderr。
  let payload = null;
  try {
    payload = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop() ?? 'null');
  } catch {
    payload = null;
  }
  if (!payload) {
    process.stderr.write(`❌ ${label} → 子进程没吐结论\n子进程 stderr:\n${r.stderr}\n`);
    failed++;
    return { modelLine: '(子进程失败)', label };
  }
  return { modelLine: payload.modelLine, afterPick: payload.afterPick, error: payload.error, label };
}

/** 把 providers 对象渲染成 patch 的极简 YAML（只要插件解析得出来即可）。 */
function renderPatch(providers) {
  const out = ['- id: llm-pi-ai', '  config:', '    providers:'];
  for (const [pid, p] of Object.entries(providers)) {
    out.push(`      ${pid}:`);
    out.push('        models:');
    for (const m of p.models) {
      out.push(`          - id: ${m.id}`);
      out.push(`            name: ${m.name ?? m.id}`);
    }
  }
  return out.join('\n') + '\n';
}

// ── 场景 ①：web 端表完全读不到（patch 没生成 / 解析失败 / 别人机器上没那份文件）──
{
  const r = await runScenario({
    port: 18971,
    providers: {},
    label: '① 表为空（web 端配置读不到）',
  });
  ok(r.modelLine.includes(PICKED), `${r.label} → 仍用手选档（实际：${r.modelLine}）`);
  ok(readState()?.hostPickedKey === PICKED, `${r.label} → 落盘 key 没被抹掉（实际：${JSON.stringify(readState())}）`);
}

// ── 场景 ②：表里别的档都在，就缺用户手选的那条（用户从 web 端删了它）──
{
  const r = await runScenario({
    port: 18972,
    providers: {
      alibailian: { models: [{ id: 'qwen3.7-flash', name: 'qwen3.7-flash' }] },
      zhipu: { models: [{ id: 'glm-5.3-flash', name: 'glm-5.3-flash' }] },
    },
    label: '② 手选档被删、别的档还在',
  });
  ok(r.modelLine.includes(PICKED), `${r.label} → 仍用手选档（实际：${r.modelLine}）`);
  ok(readState()?.hostPickedKey === PICKED, `${r.label} → 落盘 key 没被抹掉（实际：${JSON.stringify(readState())}）`);
}

// ── 场景 ③：表整体换了一批（升级 / profile 重建，档名全变）──
{
  const r = await runScenario({
    port: 18973,
    providers: {
      brandnew: { models: [{ id: 'model-x', name: 'model-x' }] },
    },
    label: '③ 表整体换了一批',
  });
  ok(r.modelLine.includes(PICKED), `${r.label} → 仍用手选档（实际：${r.modelLine}）`);
  ok(readState()?.hostPickedKey === PICKED, `${r.label} → 落盘 key 没被抹掉（实际：${JSON.stringify(readState())}）`);
}

// ── 场景 ④：手选档**在**表里时，参数要取表里的新定义（不能拿旧快照）──
{
  const r = await runScenario({
    port: 18974,
    providers: {
      zhipu: {
        models: [
          { id: 'glm-5.3-flash', name: 'glm-5.3-flash' },
          { id: 'glm-4.7-flash', name: 'glm-4.7-flash' },
        ],
      },
    },
    label: '④ 手选档仍在表里',
  });
  ok(r.modelLine.includes(PICKED), `${r.label} → 用的还是手选档（实际：${r.modelLine}）`);
  ok(!r.modelLine.includes('glm-5.3-flash'), `${r.label} → 没被表里第一条顶掉（实际：${r.modelLine}）`);
}

// ── 场景 ⑤：用户**手点**切换 —— 这是唯一该改写记忆位的入口，必须还改得动 ──
//    防的是把"自动不再改"误伤成"手点也改不了"。
//    手选的 glm-4.7-flash 先被它换成 glm-5.3-flash，落盘也要跟着换。
{
  const r = await runScenario({
    port: 18975,
    providers: {
      zhipu: {
        models: [
          { id: 'glm-5.3-flash', name: 'glm-5.3-flash' },
          { id: 'glm-4.7-flash', name: 'glm-4.7-flash' },
        ],
      },
    },
    label: '⑤ 用户手点切换到 glm-5.3-flash',
    pickKey: 'glm-5.3-flash',
  });
  if (r.error) {
    ok(false, `${r.label} → ${r.error}`);
  } else {
    ok(r.modelLine.includes('glm-4.7-flash'), `${r.label} → 切换前还在原档（实际：${r.modelLine}）`);
    ok(
      (r.afterPick ?? '').includes('glm-5.3-flash'),
      `${r.label} → 手点后真的切过去了（实际：${r.afterPick}）`,
    );
    ok(
      readState()?.hostPickedKey === 'zhipu:glm-5.3-flash',
      `${r.label} → 记忆位跟着手点改写（实际：${JSON.stringify(readState())}）`,
    );
  }
}

rmSync(WORKDIR, { recursive: true, force: true });
process.stderr.write(failed === 0 ? '\n全部通过\n' : `\n${failed} 项失败\n`);
process.exit(failed === 0 ? 0 : 1);

/**
 * /setupdsh 升级进度：只回三条状态，完整输出落日志。
 * 维护：改 setupdsh.sh 的阶段输出时，同步改这里的匹配规则。
 */
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DSH_LINE = /^✅ dsh：([^\s]+)/;
const PLUGIN_START = /把已经装了机器人的工作区里的插件|这台机器还没装过机器人插件/;
const PLUGIN_NONE = /这台机器还没装过机器人插件/;

let active = false;

/** 是否已有一轮升级在跑。 */
export function isSetupdshRunning() {
  return active;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function clock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

function stamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function dshVersion() {
  try {
    const out = execFileSync('dsh', ['--version'], { encoding: 'utf8', timeout: 3000 });
    return String(out).split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
}

function pluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
    return String(pkg.version ?? '').trim();
  } catch {
    return '';
  }
}

function makeLogPath(ts) {
  let dir = join(homedir(), '.dsh', 'setupdsh');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    dir = tmpdir();
  }
  return join(dir, `upgrade-${stamp(ts)}.log`);
}

/**
 * 启动一次升级并在后台回报三条状态。
 *
 * @param {{helper:string, reply:(text:string)=>Promise<any>, log?:Function, error?:Function}} opts
 * @returns {Promise<boolean>} false 表示已有一轮在跑。
 */
export async function runSetupdshUpgrade({ helper, reply, log = () => {}, error = () => {} }) {
  if (active) return false;
  active = true;

  const startedAt = Date.now();
  const logPath = makeLogPath(startedAt);
  const state = {
    startedAt,
    beforeDsh: dshVersion(),
    beforePlugin: pluginVersion(),
    pluginStarted: false,
    pluginSkipped: false,
    dshLine: '',
  };
  let sentDsh = false;
  let sentPlugin = false;
  let sentFinal = false;
  let dshPromise = null;
  let pluginPromise = null;
  let finalPromise = null;
  let offset = 0;
  let buffer = '';
  let timer = null;
  let finished = false;

  const say = async (text) => {
    try {
      await reply(text);
      return true;
    } catch (err) {
      error(`setupdsh 状态回话失败: ${err?.message ?? err}`);
      return false;
    }
  };

  const sendDsh = () => {
    if (sentDsh) return Promise.resolve();
    if (dshPromise) return dshPromise;
    dshPromise = (async () => {
      sentDsh = await say(`DSH：当前 ${state.beforeDsh || '未知'}，开始升级（${clock(startedAt)}，预计 2–3 分钟）`);
      dshPromise = null;
    })();
    return dshPromise;
  };

  const sendPlugin = (reason = '') => {
    if (sentPlugin) return Promise.resolve();
    if (pluginPromise) return pluginPromise;
    pluginPromise = (async () => {
      const now = Date.now();
      let text;
      if (state.pluginSkipped) {
        text = `dshbot 插件：这台机器还没装，跳过（${clock(now)}，已用 ${elapsed(now - startedAt)}）`;
      } else if (reason) {
        text = `dshbot 插件：未开始（${reason}，${clock(now)}）`;
      } else {
        text = `dshbot 插件：当前 ${state.beforePlugin || '未知'}，开始升级（${clock(now)}，已用 ${elapsed(now - startedAt)}）`;
      }
      sentPlugin = await say(text);
      pluginPromise = null;
    })();
    return pluginPromise;
  };

  const sendFinal = (code, signal) => {
    if (sentFinal) return Promise.resolve();
    if (finalPromise) return finalPromise;
    finalPromise = (async () => {
      const finishedAt = Date.now();
      const dsh = dshVersion() || state.dshLine || state.beforeDsh || '未知';
      const plugin = pluginVersion() || state.beforePlugin || '未知';
      const ok = code === 0;
      const reason = ok ? '' : `（exit ${code ?? signal ?? '?'}）`;
      const text = ok
        ? [
            `✅ 升级完成：${clock(finishedAt)}，总用时 ${elapsed(finishedAt - startedAt)}`,
            `DSH：${dsh}`,
            `dshbot 插件：${plugin}`,
            '请 /restart 后生效。',
          ].join('\n')
        : [
            `❌ 升级失败：${clock(finishedAt)}，总用时 ${elapsed(finishedAt - startedAt)}${reason}`,
            `DSH：${dsh}`,
            `dshbot 插件：${plugin}`,
            `日志：${logPath}`,
          ].join('\n');
      sentFinal = await say(text);
      finalPromise = null;
    })();
    return finalPromise;
  };

  const handleLine = (line) => {
    const dsh = line.match(DSH_LINE);
    if (dsh) {
      state.dshLine = dsh[1];
      return;
    }
    if (!state.pluginStarted && PLUGIN_START.test(line)) {
      state.pluginStarted = true;
      state.pluginSkipped = PLUGIN_NONE.test(line);
      void sendPlugin();
    }
  };

  const readNew = () => {
    let text;
    try {
      text = readFileSync(logPath, 'utf8');
    } catch {
      return;
    }
    if (!text) return;
    const chunk = text.slice(offset);
    offset = text.length;
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  };

  const finish = async (code, signal) => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    readNew();
    if (buffer) {
      handleLine(buffer);
      buffer = '';
    }
    if (!sentDsh) await sendDsh();
    if (!sentPlugin) await sendPlugin(state.dshLine ? '未检测到插件升级步骤' : 'DSH 阶段未完成');
    await sendFinal(code, signal);
    active = false;
  };

  let fd;
  try {
    fd = openSync(logPath, 'a');
  } catch (err) {
    active = false;
    error(`setupdsh 日志打不开: ${err.message}`);
    await sendDsh();
    await sendPlugin('日志打不开');
    await sendFinal(-1, null);
    return true;
  }

  let child;
  try {
    child = spawn('bash', [helper], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env },
    });
  } catch (err) {
    active = false;
    closeSync(fd);
    error(`setupdsh 升级脚本拉起失败: ${err.message}`);
    await sendDsh();
    await sendPlugin('脚本拉起失败');
    await sendFinal(-1, null);
    return true;
  }
  closeSync(fd);

  child.on('error', (err) => {
    error(`setupdsh 升级脚本拉起失败: ${err.message}`);
    void finish(-1, null);
  });
  child.on('exit', (code, signal) => {
    void finish(code, signal);
  });
  child.unref();

  // 第一条立刻发，避免升级开始后长时间没有回音。
  void sendDsh();
  timer = setInterval(readNew, 500);
  readNew();
  log(`setupdsh 升级开始，日志：${logPath}`);
  return true;
}

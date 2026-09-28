/**
 * asr.js —— 语音转文字后端分派层（插件版）
 *
 * 来源：BOT/asr.js（300 行）的 ESM 搬运。语义保持，**路径改为可配置**。
 *
 * ⚠️ 与 BOT 版的差异（为什么必须改，不能照抄）：
 *   BOT 把三个绝对路径写死在源码里 —— `/opt/homebrew/bin/whisper`、
 *   `/opt/homebrew/bin/python3.11`、以及同目录的 `asr-server.py`。
 *   那是**本机 Homebrew 布局**，插件是要发布给别人用的：别人可能用
 *   pip 装的 whisper、可能在 Linux、可能根本没有 whisper。
 *   照抄的结果是「插件在作者机器上能用，在任何人机器上都报 ENOENT」——
 *   而且报错发生在收到语音的那一刻，最难排查。
 *   因此：路径全部走 options，`null` 表示没配（会给出可操作的报错，而不是 ENOENT）。
 *
 * 两个后端：
 *   · whisper     —— openai-whisper CLI（默认）
 *   · sensevoice  —— 阿里 FunASR SenseVoice-Small，中文更准、自带标点
 *
 * 常驻服务（可选加速）：走 TCP 本机回环问一个常驻 python 进程，
 *   省掉每次 ~7s 的模型加载。没起时**静默回退**冷启动，功能不受影响。
 */

import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

/** 后端名 → 实现。未配置时 whisper。 */
export const BACKENDS = ['whisper', 'sensevoice'];

const log = (...args) => console.log('[botplugin:asr]', ...args);
const logErr = (...args) => console.error('[botplugin:asr]', ...args);

/**
 * 运行期选项。由 `configure()` 注入（插件版不再读 process.env ——
 * 宿主进程的环境变量属于**装插件的人**，不是插件的配置面）。
 *
 * 🔴 本模块内的外部命令全部未在本机实跑（本机没装 whisper CLI 的插件化调用路径）；
 *    标 推断：参数与 BOT 版逐字一致，只换了可执行文件来源。
 */
let opts = {
  whisperBin: null,
  pythonBin: null,
  keepaliveScript: null,
  keepaliveHost: '127.0.0.1',
  keepalivePort: 18081,
  keepaliveEnabled: false,
  memoryLimitGb: Infinity,
  timeoutMs: 60_000,
  sensevoiceTimeoutMs: 300_000,
};

/**
 * 注入配置。**必须在调用 transcribe() 之前调**。
 * @param {object} next 见 opts 初值；未给的键保持原样
 */
export function configure(next = {}) {
  opts = { ...opts, ...next };
  return { ...opts };
}

/** 当前配置（只读副本，供 /status 显示）。 */
export function asrConfig() {
  return { ...opts };
}

/** 当前后端名。 */
export function currentBackend() {
  return opts.backend === 'sensevoice' ? 'sensevoice' : 'whisper';
}

/**
 * 输出分隔哨兵。
 * funasr 的 check_for_update() 把 print(版本号) 写在了 `if disable: return` 之前
 * （funasr/utils/version_checker.py:28-31），所以 disable_update=True 拦不住它，
 * 版本号必定混进 stdout。用哨兵把库日志与识别文本隔开。
 */
const SENTINEL = '\u0001@@DSH_ASR_TEXT@@\u0001';

/** SenseVoice 富标签剥离：`<|zh|><|NEUTRAL|>你好` → `你好`。 */
export function stripSenseVoiceTags(s) {
  return String(s).replace(/<\|[^|]*\|>/g, '').trim();
}

// ---------------------------------------------------------------------------
// 内存闸门（决定能否常驻）
// ---------------------------------------------------------------------------

/**
 * 取「已使用内存」GB。
 *
 * = (Anonymous + Wired + Compressor) 页 × 页大小
 * 只算进程真正占住、不可回收的部分（**排除 file-backed 文件缓存**）。
 *
 * ⚠️ 判据来源（BOT 版 2026-09-16 实测，沿用）：
 *   ⛔ 不要用 top 的 PhysMem used —— 它把文件缓存算进去，
 *      会把 mmap 的模型文件当成"已用"，永远判成高内存。
 *   ⛔ 不要用 ps RSS —— 大模型进程恒报十几 GB（含 mapped file）判不出来。
 *
 * @returns {number} GB；取不到返回 0（视为充裕 → 允许常驻）
 */
export function usedMemoryGb() {
  try {
    // macOS 专用。别的平台取不到 vm_stat → 走 catch 返回 0（=充裕）。
    const out = execFileSync('/usr/bin/vm_stat', [], { timeout: 5000 }).toString();
    const num = (re) => {
      const m = out.match(re);
      return m ? Number(m[1].replace(/\./g, '')) : 0;
    };
    const anon = num(/Anonymous pages:\s+([\d.]+)/);
    const wired = num(/Pages wired down:\s+([\d.]+)/);
    const comp = num(/Pages occupied by compressor:\s+([\d.]+)/);
    return ((anon + wired + comp) * 16384) / 1024 ** 3;
  } catch {
    return 0; // 取不到就当充裕，宁可常驻（快）也不误判成不常驻
  }
}

/** 内存是否充裕（决定能否常驻）。 */
export function memoryAllowsKeepalive() {
  return usedMemoryGb() < opts.memoryLimitGb;
}

// ---------------------------------------------------------------------------
// 常驻服务
// ---------------------------------------------------------------------------

function keepaliveEnabled() {
  return opts.keepaliveEnabled === true;
}

/** 常驻服务是否已在监听（懒加载判断，不重试）。 */
function keepaliveAlive() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: opts.keepaliveHost, port: opts.keepalivePort });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(800);
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

/**
 * 懒加载拉起常驻服务（**不做开机自启**）。
 *
 * detached + unref：宿主重启不会带走它；服务自己按空闲自杀。
 * 启动是异步的（模型加载 ~2-5s），本次调用不等它 —— 本次仍走冷启动，
 * 下次语音就命中常驻。
 */
function spawnKeepalive() {
  if (!opts.pythonBin || !opts.keepaliveScript) return false;
  try {
    const child = spawn(
      opts.pythonBin,
      [opts.keepaliveScript, '--port', String(opts.keepalivePort)],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return true;
  } catch (err) {
    logErr('拉起常驻服务失败:', err.message);
    return false;
  }
}

/**
 * 通过常驻服务转写。
 * @returns {Promise<string|null>} 成功返回文本；服务不可用返回 null（调用方回退）
 */
function transcribeViaKeepalive(wavPath) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: opts.keepaliveHost, port: opts.keepalivePort });
    let buf = '';
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };

    sock.setTimeout(120_000);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ wav: wavPath }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (!buf.includes('\n')) return;
      const line = buf.split('\n', 1)[0].trim();
      if (!line) return;
      try {
        const resp = JSON.parse(line);
        if (resp.error) {
          logErr('常驻服务返回错误，回退冷启动:', resp.error);
          return done(null);
        }
        return done(stripSenseVoiceTags(resp.text ?? ''));
      } catch (e) {
        logErr('常驻服务响应解析失败，回退冷启动:', e.message);
        return done(null);
      }
    });
    // 连不上/超时：静默回退，不打断转写
    sock.on('error', () => done(null));
    sock.on('timeout', () => done(null));
  });
}

// ---------------------------------------------------------------------------
// 两个后端
// ---------------------------------------------------------------------------

/** 缺可执行文件时的报错必须可操作 —— ENOENT 对用户等于没说。 */
function requireBin(which) {
  const bin = which === 'whisper' ? opts.whisperBin : opts.pythonBin;
  if (!bin) {
    throw new Error(
      which === 'whisper'
        ? '语音转文字没配：请设置 asrWhisperBin（whisper 可执行文件路径）'
        : '语音转文字没配：请设置 asrPythonBin（python 解释器路径）',
    );
  }
  return bin;
}

/** openai-whisper CLI。参数与 BOT 版逐字一致（--model base / txt / /tmp）。 */
function transcribeWithWhisper(wavPath) {
  return execFileSync(
    requireBin('whisper'),
    [wavPath, '--model', 'base', '--output_format', 'txt', '--output_dir', '/tmp'],
    { timeout: opts.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
  ).toString().trim();
}

/**
 * FunASR SenseVoice-Small。
 *
 * 走内联 python 脚本：避免多维护一个 .py 文件，也避免 shell 引号转义问题
 * （路径通过 argv 传入）。模型权重首次运行时由 modelscope 自动下载并缓存。
 */
function transcribeWithSenseVoice(wavPath) {
  const script = `
import sys
from funasr import AutoModel

model = AutoModel(
    model="iic/SenseVoiceSmall",
    trust_remote_code=False,
    disable_update=True,
    device="cpu",
)
res = model.generate(
    input=sys.argv[1],
    language="zh",
    use_itn=True,       # 逆文本正则化：数字/日期等转成可读形式
    batch_size_s=60,
    merge_vad=False,    # 短语音不切 VAD：merge_vad=True 会吞掉句首弱起音
                        # （实测「是今天天气巴适得很…」开头 6 字被吃掉）
)
if not res:
    sys.exit(0)
# 哨兵：funasr 无论 disable_update 与否都会往 stdout 打 "funasr version: x"，
# 且可能混入别的日志。用哨兵把「库日志」和「识别文本」隔开，JS 只取哨兵之后。
print("${SENTINEL}")
print(res[0].get("text", ""))
`;

  const out = execFileSync(requireBin('python'), ['-c', script, wavPath], {
    timeout: opts.sensevoiceTimeoutMs, // 首次需下载权重 + CPU 推理，放宽到 5 分钟
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

  // 只取哨兵之后的部分：哨兵之前是 funasr 的版本/更新日志，不是转写内容。
  const idx = out.lastIndexOf(SENTINEL);
  const text = idx === -1 ? out : out.slice(idx + SENTINEL.length);

  return stripSenseVoiceTags(text);
}

/**
 * 统一入口：把 16kHz 单声道 WAV 转成文本。
 *
 * 常驻策略（沿用 BOT 2026-09-16 定的判据）：
 *   1. 内存超阈值（本地大模型占着）→ 不常驻，冷启动；
 *   2. 内存充裕 → 常驻（首次自动拉起，之后每次仅 ~0.45s）；
 *   3. 常驻服务空闲超时 → 自己退出。
 * 常驻服务没起时**静默回退**冷启动，功能不受影响。
 *
 * @param {string} wavPath 16kHz mono PCM WAV 路径
 * @returns {Promise<string>} 转写文本（可能为空字符串）
 */
export async function transcribe(wavPath) {
  const backend = currentBackend();

  if (backend === 'sensevoice' && keepaliveEnabled()) {
    if (memoryAllowsKeepalive()) {
      const alive = await keepaliveAlive();
      if (!alive) {
        // 懒加载：内存允许才拉起，拉完本次不等它（下次命中）
        if (spawnKeepalive()) log('已拉起常驻服务（内存闸门已开）');
      } else {
        const fast = await transcribeViaKeepalive(wavPath);
        if (fast !== null) return fast;
        // 服务在但出错 → 落冷启动（不报错）
      }
    } else {
      log('内存紧张，不常驻，走冷启动');
    }
  }

  if (backend === 'sensevoice') return transcribeWithSenseVoice(wavPath);
  return transcribeWithWhisper(wavPath);
}

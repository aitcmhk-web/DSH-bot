/**
 * asr.js —— 语音转文字后端分派层。
 *
 * 可执行文件路径走 options（构造时传入）；没配就按 Homebrew 默认位置找。
 * 本机压根没装引擎时回「一条能直接粘的安装命令」，而不是 ENOENT。
 *
 * 三个后端：
 *   · sensevoice  —— 阿里 FunASR SenseVoice-Small，中文准、自带标点
 *   · whisper     —— openai-whisper CLI（中文识别差，只在显式配置时用）
 *   · ali         —— 阿里 qwen3-asr-flash 线上转写（走本地模型网关 /call，~0.6s；
 *                    key 只在网关的模型表里，本进程不碰密钥。网关不在/出错自动回退本地）
 *
 * 常驻服务（可选加速）：走 TCP 本机回环问一个常驻 python 进程，
 *   省掉每次 ~7s 的模型加载。没起时静默回退冷启动，功能不受影响。
 */

import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

/** 后端名 → 实现。未配置时 sensevoice（阿里 FunASR —— 我们实际用的就是这个）。 */
export const BACKENDS = ['sensevoice', 'whisper', 'ali'];

const log = (...args) => console.log('[botplugin:asr]', ...args);
const logErr = (...args) => console.error('[botplugin:asr]', ...args);

/**
 * 运行期选项。由 configure() 注入（不读 process.env —— 宿主进程的环境变量
 * 属于装插件的人，不是插件的配置面）。
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
  // ali 后端（线上转写）的网关口。与主 bot 的 ASR_GATEWAY_URL / ASR_GATEWAY_MODEL 同默认值。
  gatewayUrl: 'http://127.0.0.1:9310/call',
  gatewayModel: '阿里转文字',
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
  return opts.backend === 'whisper' ? 'whisper' : opts.backend === 'ali' ? 'ali' : 'sensevoice';
}

// ── 阿里 qwen3-asr-flash（2026-10-06，与消息窗口/AITCM 同一条链路）────────
// 走本地「模型网关」/call：key 只存在网关的模型表里，插件全程不碰密钥。
// 信封形状与主 bot asr.js / 消息窗口 convert.mjs 的「阿里」分支一致 ——
// 同一件事只有一处定义，这里只调用、不复制第二份判断。
async function transcribeWithAli(wavPath) {
  // 网关老直通口透传「输入体」，所以 model/asr_options 塞进 输入 里
  const dataUri = `data:audio/wav;base64,${fs.readFileSync(wavPath).toString('base64')}`;
  const r = await fetch(opts.gatewayUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      模型名: opts.gatewayModel,
      输入: {
        model: 'qwen3-asr-flash',
        messages: [
          { role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] },
        ],
        asr_options: { language: 'zh', enable_itn: false },
      },
    }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`网关 HTTP ${r.status}${out.错误 ? `:${out.错误}` : ''}`);
  // 网关对普通信封原样返回上游输出 → DashScope 是 choices 形状；兼容 文本/text 变体
  const text = out.choices?.[0]?.message?.content ?? out.文本 ?? out.text ?? '';
  if (typeof text !== 'string' || !text.trim()) throw new Error('转写结果为空');
  return text.trim();
}

// ---------------------------------------------------------------------------
// 本机有没有语音引擎（没装 → 回安装命令，⛔ 绝不自动装）
// ---------------------------------------------------------------------------

/** 环境变量覆盖：用户指定 whisper/python 路径时优先用。 */
const ENV_WHISPER_BIN = process.env.ASR_WHISPER_PATH;
const ENV_PYTHON_BIN = process.env.ASR_PYTHON_PATH;

/** Homebrew 默认位置（macOS Apple Silicon）。 */
const HOMEBREW_WHISPER = '/opt/homebrew/bin/whisper';
const HOMEBREW_PYTHON = '/opt/homebrew/bin/python3.11';

/** Linux 常见位置。 */
const LINUX_PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3'];

/** CLI which 探测一个可执行文件。 */
function whichBin(name) {
  try {
    const out = execFileSync('which', [name], { timeout: 3000 });
    const p = out.toString().trim();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** 找 python：配置 > 环境变量 > Homebrew > Linux 常见路径 > which。 */
function findPython() {
  if (opts.pythonBin && exists(opts.pythonBin)) return opts.pythonBin;
  if (ENV_PYTHON_BIN && exists(ENV_PYTHON_BIN)) return ENV_PYTHON_BIN;
  if (exists(HOMEBREW_PYTHON)) return HOMEBREW_PYTHON;
  for (const p of LINUX_PYTHON) { if (exists(p)) return p; }
  return whichBin('python3') || whichBin('python');
}

/** 找 whisper：配置 > 环境变量 > Homebrew > which。 */
function findWhisper() {
  if (opts.whisperBin && exists(opts.whisperBin)) return opts.whisperBin;
  if (ENV_WHISPER_BIN && exists(ENV_WHISPER_BIN)) return ENV_WHISPER_BIN;
  if (exists(HOMEBREW_WHISPER)) return HOMEBREW_WHISPER;
  return whichBin('whisper');
}

/** 本地语音引擎的安装指令（阿里 FunASR SenseVoice-Small，离线跑、中文准）。 */
export const VOICE_INSTALL_COMMAND =
  'brew install python@3.11 ffmpeg && /opt/homebrew/bin/python3.11 -m pip install -U funasr modelscope torch torchaudio soundfile';

/**
 * 本机没装引擎时回给用户的话。
 * ⛔ 只给命令，不替用户装 —— 装什么、占多少磁盘是用户自己的事。
 */
export function voiceEngineMissingMessage() {
  return [
    '🎙 本机还没装语音转文字引擎（阿里 FunASR · SenseVoice，离线跑、中文准）。',
    '装好就能听语音，复制这一条（需要 Homebrew）：',
    '',
    VOICE_INSTALL_COMMAND,
    '',
    '（≈900MB 模型首次转写时自动下载；装完直接发语音，不用改配置。）',
  ].join('\n');
}

/** 路径存在吗（不存在返回 false，不抛）。 */
function exists(p) {
  if (!p) return false;
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

let pythonEngineOk; // undefined = 还没探过
/** python 里有没有 funasr（只探一次，结果缓存 —— import funasr 要几秒）。 */
function pythonHasFunasr(bin) {
  if (pythonEngineOk !== undefined) return pythonEngineOk;
  try {
    execFileSync(bin, ['-c', 'import funasr'], { timeout: 60_000, stdio: 'ignore' });
    pythonEngineOk = true;
  } catch {
    pythonEngineOk = false;
  }
  return pythonEngineOk;
}

/**
 * 定这次用哪个引擎、哪个可执行文件。
 * 优先级：配置 > 环境变量 > Homebrew (macOS) > Linux 常见路径 > CLI which。
 * ⛔ 不做跨后端自动顶替：默认就是 SenseVoice，本机没装它 → 提示装，
 *    不悄悄退回中文识别很差的 whisper（要用 whisper 得显式配 asrBackend）。
 */
function resolveEngine() {
  const pythonBin = findPython();

  if (currentBackend() === 'whisper') {
    const whisperBin = findWhisper();
    return whisperBin ? { backend: 'whisper', bin: whisperBin } : null;
  }

  return pythonBin && pythonHasFunasr(pythonBin) ? { backend: 'sensevoice', bin: pythonBin } : null;
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
 * 判据注意：
 *   - 不要用 top 的 PhysMem used —— 它把文件缓存算进去，会误判。
 *   - 不要用 ps RSS —— 大模型进程恒报十几 GB（含 mapped file）判不出来。
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

/** 本机没引擎时的报错：带 code，上层据此把「安装命令」原样回给用户。 */
function voiceEngineMissingError() {
  const err = new Error(voiceEngineMissingMessage());
  err.code = 'VOICE_ENGINE_MISSING';
  return err;
}

/** openai-whisper CLI（--model base / txt / /tmp）。备用后端，只在显式配了 whisper 时走。 */
function transcribeWithWhisper(wavPath, bin) {
  return execFileSync(
    bin,
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
function transcribeWithSenseVoice(wavPath, bin) {
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
)
if not res:
    sys.exit(0)
# 哨兵：funasr 无论 disable_update 与否都会往 stdout 打 "funasr version: x"，
# 且可能混入别的日志。用哨兵把「库日志」和「识别文本」隔开，JS 只取哨兵之后。
print("${SENTINEL}")
print(res[0].get("text", ""))
`;

  const out = execFileSync(bin, ['-c', script, wavPath], {
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
 * 常驻策略：
 *   1. 内存超阈值（本地大模型占着）→ 不常驻，冷启动；
 *   2. 内存充裕 → 常驻（首次自动拉起，之后每次仅 ~0.45s）；
 *   3. 常驻服务空闲超时 → 自己退出。
 * 常驻服务没起时**静默回退**冷启动，功能不受影响。
 *
 * @param {string} wavPath 16kHz mono PCM WAV 路径
 * @returns {Promise<string>} 转写文本（可能为空字符串）
 */
export async function transcribe(wavPath) {
  let backend = currentBackend();

  // 阿里线上转写（~0.6s）。网关不在 / 出错 → 回退本地链路，语音功能不因网关挂而瘫。
  if (backend === 'ali') {
    try {
      return await transcribeWithAli(wavPath);
    } catch (err) {
      logErr(`阿里线上转写失败，回退本地: ${err.message}`);
      backend = 'sensevoice'; // 本地最快链路（常驻 ~0.45s，冷启动 ~6s）
    }
  }

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

  // 本机没装引擎 → 抛出带 code 的错，上层把「安装命令」原样回给用户（⛔ 不自动装）。
  const engine = resolveEngine();
  if (!engine) throw voiceEngineMissingError();
  if (engine.backend === 'sensevoice') return transcribeWithSenseVoice(wavPath, engine.bin);
  return transcribeWithWhisper(wavPath, engine.bin);
}

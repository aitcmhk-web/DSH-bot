// asr.js — 语音转文字后端分派层
//
// 目的：把原来两处硬编码的 `whisper` 调用收敛成一个入口，并支持后端切换。
//   - whisper     : 原链路，/opt/homebrew/bin/whisper --model base（默认，行为不变）
//   - sensevoice  : 阿里 FunASR SenseVoice-Small，中文更准、自带标点
//
// 切换方式：TG/.env 里设 ASR_BACKEND=ali|sensevoice|whisper。
// 默认（未设时）= ali：线上 qwen3-asr-flash 优先（~0.6s），网关不在/出错自动回落本地
//   sensevoice（2026-10-07 老板定：默认顺序线上第一、本地第二）。
// 回退方式：显式设 ASR_BACKEND=whisper（或 sensevoice），即恢复纯本地链路。
//
// 环境一致性：与 whisper 使用同一个解释器（brew python 3.11）。
//   ⚠️ 本机 `python` = brew 3.11，而 `python3`/`pip3` = 系统 3.9，勿混用。

import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';

/** brew python 3.11 —— 与 whisper 的 shebang 同环境（见文件头说明）。 */
const PYTHON_BIN = '/opt/homebrew/bin/python3.11';

/**
 * 常驻 ASR 服务（可选加速）。
 *
 * 背景：走 execFileSync 每次冷启动要 ~7s（模型加载占大头，与音频长度无关）；
 * 常驻服务加载一次后每条仅 ~0.4s。代价是常驻 ~1.5GB 匿名内存。
 *
 * 开关：TG/.env 里设 ASR_KEEPALIVE=1 启用；未设/为 0 时行为与从前完全一致。
 * 若开关开启但服务没起，自动**静默回退**到冷启动路径（不影响可用性）。
 * 服务实现见同目录 asr-server.py（测试用，手动起停）。
 */
const KEEPALIVE_HOST = '127.0.0.1';
// ⚠️ BOT 是 TG 的独立副本，两边可能同时跑。TG 用 18080，BOT 必须换一个，
//    否则两边会抢同一个端口（先起的占住，后起的静默回退冷启动）。
//    2026-09-19 从 18080 改为 18081。
const KEEPALIVE_PORT = 18081;

/**
 * 内存阈值（GB，硬编码）。
 *
 * 本机固定 32GB，50% = 16GB。**故意不按百分比动态算** —— 机器不换，
 * 每次都去 sysctl 取总量再多算一层，纯属多余。
 *
 * 判据来源（2026-09-16 实测）：
 *   已用 = (Anonymous + Wired + Compressor) 页 × 16384 字节
 *   实测空闲态 ≈ 8.7GB；本地大模型（旧 llama-server／现 MLX VQ）加载后冲过 16GB。
 *   ⚠️ 不要用 top 的 PhysMem used —— 它把 19GB 文件缓存算进去，
 *      会把 mmap 的模型文件当成"已用"，永远判成高内存。
 *   ⚠️ 不要用 ps RSS —— llama-server 当年恒报 13.6GB（含 mapped file）判不出来；
 *      MLX VQ 同理，要量内存用 `footprint -p <pid>`，别用 RSS。
 */
const MEM_LIMIT_GB = Infinity;

/**
 * 取「已使用内存」GB。
 *
 * = (Anonymous pages + Pages wired down + Pages occupied by compressor) × 页大小
 * 只算进程真正占住、不可回收的部分（排除 file-backed 文件缓存）。
 *
 * @returns {number} GB；取不到时返回 0（视为内存充裕 → 允许常驻）
 */
function usedMemoryGB() {
  try {
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
  return usedMemoryGB() < MEM_LIMIT_GB;
}

/** 常驻服务是否已在监听（用于懒加载判断，不做重试）。 */
function keepaliveAlive() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: KEEPALIVE_HOST, port: KEEPALIVE_PORT });
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
 * detached + unref：bot 重启/退出不会带走它；服务自己按 10 分钟空闲自杀。
 * 启动是异步的（模型加载 ~2-5s），本次调用不等它 —— 本次仍走冷启动，
 * 下次语音就命中常驻。
 */
function spawnKeepalive() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const child = spawn(
      PYTHON_BIN,
      [path.join(here, 'asr-server.py'), '--port', String(KEEPALIVE_PORT)],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 是否启用常驻服务。未配置 => false（行为不变）。 */
function keepaliveEnabled() {
  const v = String(process.env.ASR_KEEPALIVE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * 通过常驻服务转写。
 * @returns {Promise<string|null>} 成功返回文本；服务不可用返回 null（调用方回退）
 */
function transcribeViaKeepalive(wavPath) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: KEEPALIVE_HOST, port: KEEPALIVE_PORT });
    let buf = '';
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };

    sock.setTimeout(120000);
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
          console.error('[asr] keepalive 返回错误，回退冷启动:', resp.error);
          return done(null);
        }
        return done(stripSenseVoiceTags(resp.text ?? ''));
      } catch (e) {
        console.error('[asr] keepalive 响应解析失败，回退冷启动:', e.message);
        return done(null);
      }
    });
    // 连不上/超时：静默回退，不打断转写
    sock.on('error', () => done(null));
    sock.on('timeout', () => done(null));
  });
}

/** 原链路：openai-whisper CLI。 */
const WHISPER_BIN = '/opt/homebrew/bin/whisper';

/**
 * 输出分隔哨兵。
 * funasr 的 check_for_update() 把 print(版本号) 写在了 `if disable: return` 之前
 * （见 funasr/utils/version_checker.py:28-31），所以 disable_update=True 拦不住它，
 * 版本号必定混进 stdout。用哨兵把库日志与识别文本隔开。
 * 取一个不可能出现在转写文本里的串，避免误切。
 */
const SENTINEL = '\u0001@@DSH_ASR_TEXT@@\u0001';

/** 后端名 → 实现。默认 ali（线上优先，失败自动回落本地——2026-10-07 老板定）。 */
export function currentBackend() {
  const v = String(process.env.ASR_BACKEND ?? '').trim().toLowerCase();
  return v === 'sensevoice' ? 'sensevoice' : v === 'whisper' ? 'whisper' : 'ali';
}

// ── 阿里 qwen3-asr-flash（2026-10-06，与消息窗口/AITCM 同一条链路）────────
// 走本地「模型网关」/call（127.0.0.1:9310）：key 只存在网关的模型表里，bot 全程不碰密钥。
// 信封形状与 framework/projects/消息窗口/modules/convert/convert.mjs 的「阿里」分支一致
// ——同一件事只有一处定义，这里只调用、不复制第二份判断。
const ASR_GATEWAY_URL = process.env.ASR_GATEWAY_URL ?? 'http://127.0.0.1:9310/call';
const ASR_GATEWAY_MODEL = process.env.ASR_GATEWAY_MODEL ?? '阿里转文字';

async function transcribeWithAli(wavPath) {
  // 网关老直通口透传「输入体」，所以 model/asr_options 塞进 输入 里（见 convert.mjs 注释）
  const dataUri = `data:audio/wav;base64,${readFileSync(wavPath).toString('base64')}`;
  const r = await fetch(ASR_GATEWAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      模型名: ASR_GATEWAY_MODEL,
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

/**
 * 用 whisper 转写。
 * 参数与改动前完全一致（--model base / txt / /tmp），保证可对照。
 */
function transcribeWithWhisper(wavPath) {
  return execFileSync(
    WHISPER_BIN,
    [wavPath, '--model', 'base', '--output_format', 'txt', '--output_dir', '/tmp'],
    { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
  ).toString().trim();
}

/**
 * 用 FunASR SenseVoice-Small 转写。
 *
 * 走一个内联 python 脚本：避免多维护一个 .py 文件，
 * 也避免 shell 引号转义问题（路径通过 argv 传入）。
 * 模型权重首次运行时由 modelscope 自动下载并缓存到 ~/.cache/modelscope。
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

  const out = execFileSync(PYTHON_BIN, ['-c', script, wavPath], {
    timeout: 300000, // 首次需下载权重 + CPU 推理，放宽到 5 分钟
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

  // 只取哨兵之后的部分：哨兵之前是 funasr 的版本/更新日志，不是转写内容。
  const idx = out.lastIndexOf(SENTINEL);
  const text = idx === -1 ? out : out.slice(idx + SENTINEL.length);

  return stripSenseVoiceTags(text);
}

/**
 * SenseVoice 会在文本里输出富标签，如：
 *   <|zh|><|NEUTRAL|><|Speech|><|woitn|>你好
 * 这里剥掉所有 <|...|> 标签，只留纯文本。
 */
function stripSenseVoiceTags(s) {
  return String(s)
    .replace(/<\|[^|]*\|>/g, '')
    .trim();
}

/**
 * 统一入口：把 16kHz 单声道 WAV 转成文本。
 *
 * 常驻策略（2026-09-16 定）：
 *   1. 内存 > 16GB（本地大模型占着）→ 不常驻，冷启动；
 *   2. 内存 < 16GB → 常驻（首次自动拉起，之后每次仅 ~0.45s）；
 *   3. 常驻服务 10 分钟无转写 → 自己退出（见 asr-server.py）。
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
      console.error(`[asr] 阿里线上转写失败，回退本地: ${err.message}`);
      backend = 'sensevoice'; // 本地最快链路（常驻 ~0.45s，冷启动 ~6s）
    }
  }

  if (backend === 'sensevoice' && keepaliveEnabled()) {
    const memOk = memoryAllowsKeepalive();

    if (memOk) {
      const alive = await keepaliveAlive();
      if (!alive) {
        // 懒加载：内存允许才拉起，拉完本次不等它（下次命中）
        if (spawnKeepalive()) {
          console.log(`[asr] 已拉起常驻服务（内存闸门已关，不判内存）`);
        }
      } else {
        const fast = await transcribeViaKeepalive(wavPath);
        if (fast !== null) return fast;
        // 服务在但出错 → 落冷启动（不报错）
      }
    } else {
      console.log(`[asr] 内存紧张，不常驻，走冷启动`);
    }
  }

  if (backend === 'sensevoice') {
    return transcribeWithSenseVoice(wavPath);
  }
  return transcribeWithWhisper(wavPath);
}

export const BACKENDS = ['whisper', 'sensevoice', 'ali'];

// server.mjs · 本地转写服务：阿里 FunASR SenseVoice-Small（跟现役 bot 同一引擎，离线、免费、中文准）
// 收 {文件: 路径} → ffmpeg 转 16k 单声道 wav → python FunASR 转写 → {文本}
// 调用口径与 BOT/src/asr.js 一致：哨兵分隔库日志、剥 SenseVoice 富标签
import { createServer } from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));   // modules/stt
const ROOT = join(HERE, '..', '..');                    // 项目根
const TMP = join(ROOT, '临时文件');
const PYTHON = process.env.转写python ?? '/opt/homebrew/bin/python3.11';
const PORT = Number(process.env.转写端口 ?? 9911);
const SENTINEL = '\x01@@DSH_ASR_TEXT@@\x01';
// ffmpeg 用绝对路径：launchd 拉起时 PATH 窄（不含 homebrew），裸名字会 ENOENT（2026-10-06 语音卡壳真因）
const FFMPEG = '/opt/homebrew/bin/ffmpeg';

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function toWav16k(输入) {
  mkdirSync(TMP, { recursive: true });
  const out = join(TMP, `${Date.now()}-16k.wav`);
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', 输入, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out]);
  if (r.status !== 0) throw new Error(`ffmpeg 转wav失败：${String(r.stderr).slice(0, 300)}`);
  return out;
}

function 转写(wav路径) {
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
    use_itn=True,
    batch_size_s=60,
    merge_vad=False,
)
if not res:
    sys.exit(0)
print('\\x01@@DSH_ASR_TEXT@@\\x01')
print(res[0].get("text", ""))
`;
  const out = execFileSync(PYTHON, ['-c', script, wav路径], {
    timeout: 300000, // 首次加载模型慢，放宽
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  const i = out.lastIndexOf(SENTINEL);
  let text = i === -1 ? out : out.slice(i + SENTINEL.length);
  return text.replace(/<\|[^|]*\|>/g, '').trim(); // 剥 <|zh|><|NEUTRAL|> 这类富标签
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/audio/transcriptions')) {
      return json(res, 404, { 错误: '无此接口' });
    }
    let d = '';
    for await (const c of req) d += c;
    const { 文件 } = JSON.parse(d || '{}');
    if (!文件 || !existsSync(文件)) return json(res, 400, { 错误: '文件不存在或没给' });
    const wav = toWav16k(文件);
    const 文本 = 转写(wav);
    console.log(`[转写] ${文件} → ${文本.slice(0, 60)}`);
    return json(res, 200, { 文本 });
  } catch (e) {
    return json(res, 500, { 错误: String(e?.message ?? e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`本地转写服务已起（FunASR SenseVoice）：http://127.0.0.1:${PORT} · python=${PYTHON}`);
});

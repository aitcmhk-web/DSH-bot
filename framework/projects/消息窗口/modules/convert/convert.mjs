// convert.mjs · 格式归一：把各通道原始消息统一成标准消息；语音转文字=可选开关
// 零数据库：文件只落 临时文件/，用完即删
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // modules/convert
const ROOT = join(HERE, '..', '..');                  // 项目根
const TMP = join(ROOT, '临时文件');

// ffmpeg 用绝对路径：launchd 拉起时 PATH 很窄（不含 homebrew），裸名字会 ENOENT（2026-10-06 语音失败真因）
const FFMPEG = '/opt/homebrew/bin/ffmpeg';

// toMp3：语音归一 → mp3 16k 单声道（ffmpeg 为系统依赖，契约写明）
export function toMp3(输入路径) {
  const out = 输入路径.replace(/\.[^.]+$/, '') + '.mp3';
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', 输入路径, '-vn', '-acodec', 'libmp3lame', '-ar', '16000', '-ac', '1', out]);
  if (r.status !== 0) throw new Error(`ffmpeg 转码失败：${String(r.stderr).slice(0, 300)}`);
  登记(out);
  谱系.set(out, [输入路径]); // 删 mp3 时把原始 ogg 一并带走
  return out;
}

// 存临时文件：落盘到 临时文件/，返回路径（唯一的落盘点，零数据原则）
// 目录可注入（测试用，#18 ③）；谁写谁登记——写盘即在生命周期登记表挂账
export function 存临时文件(buffer, 文件名, 目录 = TMP) {
  mkdirSync(目录, { recursive: true });
  const path = join(目录, `${Date.now()}-${文件名 ?? '文件'}`);
  writeFileSync(path, buffer);
  return 登记(path);
}

// —— 临时文件生命周期（#18 ③）：谁写谁登记；投递成功即删；失败保留待查不静默；启动扫尾清残骸 ——
// 登记表只记内存（零数据原则）：进程重启即空，目录里现存的全部按「上个进程残骸」处理
const 已登记 = new Map(); // 路径 → 登记时间戳
const 谱系 = new Map();   // 衍生文件 → [来源文件们]（删衍生时把来源一并带走，如 ogg→mp3、原图→jpg、list.txt→merged）

function 登记(路径) {
  已登记.set(路径, Date.now());
  return 路径;
}

// 删临时文件：投递成功后调用。只删登记在册的（防误删非临时文件，未登记只报告不动手）；
// 谱系上的来源（原始 ogg / 转换前的图 / ffmpeg 的 list.txt）一并带走。删不掉不抛——保留待查已打日志。
export function 删临时文件(路径, 已删 = new Set()) {
  if (!路径 || 已删.has(路径)) return;
  已删.add(路径);
  if (!已登记.has(路径)) {
    console.log(`[临时文件] 未登记，不删（保留待查）: ${路径}`);
    return;
  }
  try {
    unlinkSync(路径);
    已登记.delete(路径);
    const 来源们 = 谱系.get(路径) ?? [];
    谱系.delete(路径);
    for (const 来源 of 来源们) 删临时文件(来源, 已删);
  } catch (e) {
    console.log(`[临时文件] 删除失败（保留待查）: ${路径} ${e?.message ?? e}`);
  }
}

// 启动扫尾：只在进程启动、收任何消息之前调用（此刻登记表为空，目录里全是上个进程残骸——全清）。
// 目录可注入（测试用）。返回 { 删了, 字节 } 供启动日志报数。
export function 扫尾临时文件(目录 = TMP) {
  let 删了 = 0, 字节 = 0;
  let 名单 = [];
  try { 名单 = readdirSync(目录); } catch { return { 删了, 字节 }; } // 目录不存在=无残骸
  for (const 名字 of 名单) {
    const p = join(目录, 名字);
    try {
      字节 += statSync(p).size;
      unlinkSync(p);
      已登记.delete(p);
      删了++;
    } catch (e) {
      console.log(`[临时文件] 扫尾跳过 ${p}: ${e?.message ?? e}`);
    }
  }
  谱系.clear();
  return { 删了, 字节 };
}

// toJpgPng：图片归一 → jpg/png（2026-10-05 契约默认：视觉模型通吃格式）。
// 已是 jpg/png 原样返回；其它（gif/webp/heic…）用系统 sips 转 jpg；转换失败保留原件——宁缺格式不丢图。
const 图片魔数 = (buf) =>
  buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg'
  : buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 ? 'png'
  : null;

export function toJpgPng(路径) {
  const kind = 图片魔数(readFileSync(路径));
  if (kind) return 路径;
  const out = 路径.replace(/\.[^.]+$/, '') + '.jpg';
  const r = spawnSync('sips', ['-s', 'format', 'jpeg', 路径, '--out', out]);
  if (r.status !== 0 || !existsSync(out)) {
    console.error(`[convert] sips 归一失败（保留原件 ${路径}）: ${String(r.stderr).slice(0, 200)}`);
    return 路径;
  }
  登记(out);
  谱系.set(out, [路径]); // 删转换后的 jpg 时把原图（gif/webp/heic）一并带走
  return out;
}

// normalize(原始) → 标准消息
// 原始: { 通道, chatId, 类型: 文字|语音|图片|视频, 文字?, 文件URL?, 文件名? }
// 标准: { 类型, 文件, 文字, 通道, chatId, 项目:null }（项目由 route 填）
export async function normalize(原始) {
  const 标准 = {
    类型: 原始.类型 ?? '文字',
    文件: null,
    文字: 原始.文字 ?? '',
    通道: 原始.通道 ?? 'tg',
    chatId: 原始.chatId ?? null,
    项目: null,
  };
  if (原始.文件URL) {
    const r = await fetch(原始.文件URL);
    if (!r.ok) throw new Error(`拉取文件失败：HTTP ${r.status}`);
    标准.文件 = 存临时文件(Buffer.from(await r.arrayBuffer()), 原始.文件名 ?? '文件');
    if (标准.类型 === '语音') 标准.文件 = toMp3(标准.文件); // 语音归一成 mp3，原始 ogg 留在临时目录
  }
  if (标准.类型 === '图片' && 标准.文件) 标准.文件 = toJpgPng(标准.文件); // 图片归一 jpg/png（契约定稿默认）
  return 标准;
}

// concatMp3：多段 mp3 拼接成一条（同管线产物、编码一致，直接流拷贝）
export function concatMp3(文件列表) {
  mkdirSync(TMP, { recursive: true });
  const list = join(TMP, `${Date.now()}-list.txt`);
  writeFileSync(list, 文件列表.map((f) => `file '${f}'`).join('\n') + '\n');
  const out = join(TMP, `${Date.now()}-merged.mp3`);
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
  if (r.status !== 0) throw new Error(`ffmpeg 拼接失败：${String(r.stderr).slice(0, 300)}`);
  登记(list);
  登记(out);
  谱系.set(out, [...文件列表, list]); // 删拼接产物时把各段 mp3 和 list.txt 一并带走
  return out;
}

// toText(语音文件, 配置) → { 开, 文本, 原文 }
// 配置.转换器 = { 地址, key, 模型名? }；地址没填 = 开关关着，原样返回
// 模型名给了 = 走模型网关 /call 信封 {模型名, 输入}；没给 = 直连转换器
// 形状='阿里'（2026-10-06 切 qwen3-asr-flash，实测 0.56s vs 本地 5.83s）：音频必须 base64 Data URL（本地路径阿里够不着），
// 网关老直通口透传输入体，所以 model/asr_options 要塞进 输入 里（模型表条目只供地址+key）
export async function toText(语音文件, 配置 = {}) {
  const 转换器 = 配置.转换器;
  if (!转换器?.地址) return { 开: false, 文本: null, 原文: 语音文件 };
  let 信封;
  if (转换器.形状 === '阿里') {
    const dataUri = `data:audio/mpeg;base64,${readFileSync(语音文件).toString('base64')}`;
    信封 = {
      模型名: 转换器.模型名,
      输入: {
        model: 'qwen3-asr-flash',
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] }],
        asr_options: { language: 'zh', enable_itn: false },
      },
    };
  } else {
    信封 = 转换器.模型名
      ? { 模型名: 转换器.模型名, 输入: { 文件: 语音文件 } }
      : { 文件: 语音文件 };
  }
  let r;
  try {
    r = await fetch(转换器.地址, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${转换器.key ?? ''}` },
      body: JSON.stringify(信封),
    });
  } catch {
    throw new Error(`转换器不可达：连接失败（${转换器.地址}）`);
  }
  if (!r.ok) throw new Error(`转换器不可达：HTTP ${r.status}`);
  const out = await r.json().catch(() => ({}));
  const 文本 = out.文本 ?? out.text ?? out.choices?.[0]?.message?.content ?? '';
  return { 开: true, 文本: typeof 文本 === 'string' ? 文本 : JSON.stringify(文本), 原文: 语音文件 };
}

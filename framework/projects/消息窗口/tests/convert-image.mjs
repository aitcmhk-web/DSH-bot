// convert-image.mjs · #24 图片归一跨平台实测（toJpgPng：sips → ffmpeg，D15 Ubuntu 兼容）
// 样张自造：jpg/png/webp/gif 用 ffmpeg lavfi 现造（跨平台零依赖）；
// heic 样张用 sips 从 png 转出（⛔ 仅测试造样张用——运行时代码零 sips，验收判据①允许测试用 sips）。
// 判据：① jpg 直通 ② png 直通 ③ webp/gif/heic 真转 jpg ≥2 种（产物魔数 FF D8 + 原件保留 + 谱系同删）
//       ④ heic：ffmpeg 解得动→验 jpg 产物；解不动→验失败分支保原件（契约两分支都合法，按机构建实测）
//       ⑤ 坏图文件 → 失败保留原件、不抛死
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { toJpgPng, 存临时文件, 删临时文件 } from '../modules/convert/convert.mjs';

const FF = process.env.FFMPEG路径
  || ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => existsSync(p))
  || 'ffmpeg';

let 失败 = 0, 总数 = 0;
const 断言 = (名, 条件) => { 总数++; console.log(`${条件 ? '✅' : '❌'} ${名}`); if (!条件) 失败++; };
const 是Jpg = (buf) => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
const 是Png = (buf) => buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50;

const dir = mkdtempSync(join(tmpdir(), 'convert24-'));
const 造样张 = (名, 参数) => {
  const p = join(dir, 名);
  const r = spawnSync(FF, ['-y', '-loglevel', 'error', ...参数, p], { stdio: 'pipe' });
  if (r.status !== 0 || !existsSync(p)) {
    console.log(`ℹ️ 样张 ${名} 造不出（本机 ffmpeg 缺该编码器，status=${r.status}）`);
    return null;
  }
  return p;
};

const jpg样 = 造样张('样.jpg', ['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=2', '-frames:v', '1']);
const png样 = 造样张('样.png', ['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=2', '-frames:v', '1']);
const webp样 = 造样张('样.webp', ['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=2', '-frames:v', '1']);
const gif样 = 造样张('样.gif', ['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=5', '-t', '0.6']);

// webp 兜底：本机 ffmpeg 若缺 libwebp 编码器造不出样张，用 sips 从 png 转出（⛔ 仅测试造样张用，与 heic 同理；
// ffmpeg 侧只需 webp 解码器——实测本机有 `VF...D webp`，转换方向不受编码器缺席影响）
if (!webp样 && png样) {
  const webp路径 = join(dir, '样.webp');
  const r = spawnSync('/usr/bin/sips', ['-s', 'format', 'webp', png样, '--out', webp路径], { stdio: 'pipe' }); // 仅测试造样张用
  if (r.status === 0 && existsSync(webp路径)) webp样 = webp路径;
  else console.log('ℹ️ webp 样张 sips 兜底也造不出——跳过');
}

console.log('—— ① jpg 直通 ——');
if (!jpg样) 断言('jpg 样张缺失（ffmpeg 连 jpg 都造不出=环境异常）', false);
else {
  断言('jpg 样张魔数确实是 jpg', 是Jpg(readFileSync(jpg样)));
  断言('jpg → 原路径原样返回（直通）', toJpgPng(jpg样) === jpg样);
}

console.log('—— ② png 直通 ——');
if (!png样) 断言('png 样张缺失（ffmpeg 连 png 都造不出=环境异常）', false);
else {
  断言('png 样张魔数确实是 png', 是Png(readFileSync(png样)));
  断言('png → 原路径原样返回（直通）', toJpgPng(png样) === png样);
}

console.log('—— ③ webp / gif / heic 真转 jpg（≥2 种达标）+ 谱系同删 ——');
const 真转达标 = [];
const 真转一单 = (名, 样张) => {
  if (!样张) { console.log(`ℹ️ ${名} 样张缺失——跳过（达标线看「真转 ≥2 种」总断言）`); return; }
  const 原 = 存临时文件(readFileSync(样张), `x.${名}`, dir); // 走真登记（复刻 normalize：先存再转）
  const out = toJpgPng(原);
  if (out === 原) { 断言(`${名} → 未转换（本机 ffmpeg 解不动该格式）`, false); return; }
  断言(`${名} → 返回 .jpg 新路径`, out.endsWith('.jpg'));
  断言(`${名} → 产物魔数是 jpg（FF D8）`, existsSync(out) && 是Jpg(readFileSync(out)));
  断言(`${名} → 原件保留（不丢图）`, existsSync(原));
  删临时文件(out);
  断言(`${名} → 谱系照旧：删 jpg 带走原图`, !existsSync(out) && !existsSync(原));
  真转达标.push(名);
};
真转一单('webp', webp样);
真转一单('gif', gif样);

// heic：ffmpeg 是否支持 HEIF/HEVC 解码因构建而异——两分支都合法，按机构建实测
let heic样 = null;
{
  const heic路径 = join(dir, '样.heic');
  const r = spawnSync('/usr/bin/sips', ['-s', 'format', 'heic', png样 ?? '', '--out', heic路径], { stdio: 'pipe' }); // 仅测试造样张用
  if (png样 && r.status === 0 && existsSync(heic路径)) heic样 = heic路径;
}
if (!heic样) console.log('ℹ️ heic 样张造不出（非 mac 或 sips 缺席）——跳过');
else 真转一单('heic', heic样);
断言(`真转 jpg 达标 ≥2 种（实转：${真转达标.join('、') || '无'}）`, 真转达标.length >= 2);

console.log('—— ④ 坏图 → 失败保留原件不抛死 ——');
{
  const 坏 = 存临时文件(Buffer.from('这不是图片，是文本'), '坏图.webp', dir);
  let out = null, 抛 = null;
  try { out = toJpgPng(坏); } catch (e) { 抛 = e; }
  断言('坏图 → 不抛异常', !抛);
  断言('坏图 → 返回原路径（宁缺格式不丢图）', out === 坏);
  断言('坏图 → 原件内容原封不动', readFileSync(坏).toString() === '这不是图片，是文本');
}

rmSync(dir, { recursive: true, force: true });
console.log(`—— #24 图片归一跨平台：${总数} 断言，失败 ${失败} ——`);
process.exit(失败 ? 1 : 0);

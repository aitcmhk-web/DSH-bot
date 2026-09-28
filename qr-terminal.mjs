/**
 * 终端二维码渲染 —— 零 npm 依赖，用 macOS 原生 CoreImage 生成。
 *
 * 为什么要这个文件:
 *   iLink 登录接口返回的 `qrcode_img_content` **不是图片，是一个 URL**
 *   （`https://liteapp.weixin.qq.com/q/XXXX?qrcode=...&bot_type=3`）。
 *   官方插件 @tencent-weixin/openclaw-weixin 用 npm 包 `qrcode-terminal`
 *   把这个 URL 渲染成终端二维码。本项目坚持零依赖，所以改用 macOS 自带的
 *   CoreImage（CIQRCodeGenerator）生成，再把位图还原成终端字符块。
 *
 * 原理:
 *   1. `osascript -l JavaScript` 调 CoreImage 生成二维码，写成未缩放的 BMP
 *      （每模块 1 像素，所以像素数 = 模块数）；
 *   2. Node 解析 BMP，得到 0/1 模块矩阵；
 *   3. 打印成 `██` / `  ` 两字符一模块，外加静区（quiet zone）。
 *
 * 非 macOS / 无 osascript 时 `renderTerminalQR()` 返回 null，
 * 调用方应退回「只打印 URL」。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 纠错级别：L/M/Q/H。M(15%) 在屏幕扫描场景下够用且不至于让码过大。 */
const EC_LEVEL = 'M';

/** 静区宽度（模块）。规范建议 4；终端里 2 已足够扫，且不会撑爆窄终端。 */
const QUIET_ZONE = 2;

/**
 * JXA 源码，按行传给 `osascript -e`（多段 -e 会以换行拼接）。
 * 调用约定：`run([url, outPath])`。
 */
const JXA_LINES = [
  'ObjC.import("Foundation"); ObjC.import("CoreImage"); ObjC.import("AppKit");',
  'function run(argv) {',
  '  const url = argv[0], out = argv[1];',
  '  const data = $(url).dataUsingEncoding($.NSUTF8StringEncoding);',
  '  const f = $.CIFilter.filterWithName("CIQRCodeGenerator");',
  '  f.setValueForKey(data, "inputMessage");',
  `  f.setValueForKey($("${EC_LEVEL}"), "inputCorrectionLevel");`,
  '  const img = f.outputImage;',
  '  if (!img || img.isNil()) return "ERR:no-output-image";',
  '  const ctx = $.CIContext.context;',
  '  const cg = ctx.createCGImageFromRect(img, img.extent);',
  '  const rep = $.NSBitmapImageRep.alloc.initWithCGImage(cg);',
  '  const bmp = rep.representationUsingTypeProperties($.NSBitmapImageFileTypeBMP, $());',
  '  return bmp.writeToFileAtomically($(out), true) ? "OK" : "ERR:write-failed";',
  '}',
];

/**
 * 解析 NSBitmapImageRep 写出的 BMP，返回 { matrix, width, height }。
 * 兼容 24/32bpp、自下而上/自上而下、BI_BITFIELDS；只关心明暗。
 * @param {Buffer} b
 */
export function matrixFromBmpBuffer(b) {
  if (b.length < 54 || b.toString('ascii', 0, 2) !== 'BM') throw new Error('不是 BMP');
  const off = b.readUInt32LE(10);
  const width = b.readInt32LE(18);
  const rawHeight = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28);
  const compression = b.readUInt32LE(30);
  if (compression !== 0 && compression !== 3) throw new Error(`不支持的 BMP 压缩: ${compression}`);
  if (bpp !== 32 && bpp !== 24) throw new Error(`不支持的 BMP 位深: ${bpp}`);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const bytesPerRow = Math.floor((bpp * width + 31) / 32) * 4;
  const bytesPerPixel = bpp / 8;

  // 任意通道足够黑即视为暗模块（白=所有通道 255，黑=所有通道 0）。
  const isDark = (x, y) => {
    const row = topDown ? y : height - 1 - y;
    const p = off + row * bytesPerRow + x * bytesPerPixel;
    if (p + 2 >= b.length) throw new Error('BMP 数据越界');
    return Math.max(b[p], b[p + 1], b[p + 2]) < 128;
  };

  // 定位符号区域：三个定位图案保证「最左/最上暗列行」= 符号第 0 行/列，
  // 右上定位图案保证最右暗列 = 最后 1 列，左下定位图案保证最下暗行 = 最后 1 行。
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isDark(x, y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('BMP 里没有暗像素');

  const n = maxX - minX + 1;
  if (maxY - minY + 1 !== n) throw new Error(`符号区不是正方形: ${n}x${maxY - minY + 1}`);
  // QR 版本性质：模块数 = 17 + 4*version，version ∈ [1,40]。
  if (n < 21 || n > 177 || (n - 17) % 4 !== 0) throw new Error(`模块数不合法: ${n}`);

  const matrix = [];
  for (let r = 0; r < n; r++) {
    const row = new Uint8Array(n);
    for (let c = 0; c < n; c++) row[c] = isDark(minX + c, minY + r) ? 1 : 0;
    matrix.push(row);
  }
  return { matrix, width, height };
}

/** 三个定位图案必须是标准形状 —— 用来自证 BMP 解析没错位/没反色。 */
export function hasFinderPatterns(matrix) {
  const n = matrix.length;
  const at = (r, c) => matrix[r]?.[c];
  const check = (r0, c0) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const want = edge || core ? 1 : 0;
        if (at(r0 + r, c0 + c) !== want) return false;
      }
    }
    return true;
  };
  return check(0, 0) && check(0, n - 7) && check(n - 7, 0);
}

/** 模块矩阵 → 终端字符串。 */
export function formatMatrix(matrix, quietZone = QUIET_ZONE) {
  const n = matrix.length;
  const blank = '  '.repeat(n + quietZone * 2);
  const pad = '  '.repeat(quietZone);
  const lines = [];
  for (let i = 0; i < quietZone; i++) lines.push(blank);
  for (let r = 0; r < n; r++) {
    let line = pad;
    for (let c = 0; c < n; c++) line += matrix[r][c] ? '██' : '  ';
    lines.push(line + pad);
  }
  for (let i = 0; i < quietZone; i++) lines.push(blank);
  return lines.join('\n');
}

/**
 * 渲染终端二维码。
 * @param {string} text 要编码的内容（这里是 iLink 返回的 qrcode_img_content URL）
 * @returns {string|null} 可直接 console.log 的二维码；失败返回 null（调用方退回打印 URL）
 */
export function renderTerminalQR(text) {
  if (process.platform !== 'darwin') return null;
  const out = join(tmpdir(), `dsh-qr-${process.pid}-${Date.now()}.bmp`);
  try {
    const args = ['-l', 'JavaScript'];
    for (const line of JXA_LINES) args.push('-e', line);
    args.push(text, out);
    const res = spawnSync('osascript', args, { encoding: 'utf8', timeout: 15000 });
    if (res.status !== 0) return null;
    const bmp = readFileSync(out);
    const { matrix } = matrixFromBmpBuffer(bmp);
    if (!hasFinderPatterns(matrix)) return null;
    return formatMatrix(matrix);
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(out);
    } catch {}
  }
}

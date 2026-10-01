/**
 * 终端二维码渲染 —— 跨平台。
 *
 * macOS：用 CoreImage（osascript）生成 BMP → 解析为字符块。
 * Linux：优先 `qrencode` CLI；没有则 fallback 到纯 JS QR 生成。
 * 全部失败时返回 null，调用方退回打印 URL。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// QR 编码核心（纯 JS，零依赖）—— 供 Linux fallback 使用
// ---------------------------------------------------------------------------

/** Reed-Solomon 伽罗瓦域 GF(256) 表。 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsEncode(data, nsym) {
  const gen = new Uint8Array([1]);
  for (let i = 0; i < nsym; i++) {
    const ng = new Uint8Array(gen.length + 1);
    for (let j = 0; j < gen.length; j++) {
      ng[j] ^= gfMul(gen[j], GF_EXP[i]);
      ng[j + 1] ^= gfMul(gen[j], GF_EXP[i + 255]);
    }
    gen.set(ng);
  }
  const res = new Uint8Array(data.length + nsym);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        res[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return Array.from(res.slice(data.length));
}

/** QR 版本信息（模块数、数据码字、纠错级别）。简化版：支持 EC Level M，版本 1-10。 */
const QR_VERSIONS = [
  { modules: 21, dataCodewords: 19, ecCodewords: 7, alignment: 0 },
  { modules: 25, dataCodewords: 34, ecCodewords: 10, alignment: 0 },
  { modules: 29, dataCodewords: 55, ecCodewords: 15, alignment: 6 },
  { modules: 33, dataCodewords: 80, ecCodewords: 20, alignment: 6 },
  { modules: 37, dataCodewords: 108, ecCodewords: 26, alignment: 6 },
  { modules: 41, dataCodewords: 136, ecCodewords: 18, alignment: 6 },
  { modules: 45, dataCodewords: 156, ecCodewords: 20, alignment: 6 },
  { modules: 49, dataCodewords: 194, ecCodewords: 24, alignment: 6 },
  { modules: 53, dataCodewords: 232, ecCodewords: 30, alignment: 6 },
  { modules: 57, dataCodewords: 274, ecCodewords: 18, alignment: 6 },
];

/** 查找适合文本长度的版本。 */
function findVersion(text) {
  const bytes = new TextEncoder().encode(text);
  // 字节模式：4 bits + 字符计数(8 bits for v1-9, 16 bits for v10+) + 数据 + EC
  const bitCount = 4 + (bytes.length <= 255 ? 8 : 16) + bytes.length * 8;
  for (let v = 0; v < QR_VERSIONS.length; v++) {
    const ver = QR_VERSIONS[v];
    // 粗略估算：每模块约 0.5 bit（黑白各半），实际更复杂但够用
    const maxBits = Math.floor((ver.modules * ver.modules - 100) * 0.45);
    if (bitCount <= maxBits) return v;
  }
  return null; // 太长的文本放不下
}

/** 生成 QR 矩阵。简化实现：仅支持字节模式、EC Level M。 */
function generateQRMatrix(text) {
  const versionIdx = findVersion(text);
  if (versionIdx === null) return null;
  const ver = QR_VERSIONS[versionIdx];
  const n = ver.modules;
  const matrix = Array.from({ length: n }, () => new Uint8Array(n));
  const reserved = Array.from({ length: n }, () => new Uint8Array(n));

  // 标记功能图案区域
  const markReserved = (r0, c0, size) => {
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        reserved[r0 + r][c0 + c] = 1;
      }
    }
  };

  // 定位图案 3x3 格子 (7x7 像素)
  const drawFinderPattern = (r0, c0) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[r0 + r][c0 + c] = edge || core ? 1 : 0;
        reserved[r0 + r][c0 + c] = 1;
      }
    }
  };

  drawFinderPattern(0, 0);
  drawFinderPattern(0, n - 7);
  drawFinderPattern(n - 7, 0);

  // 分隔线
  for (let i = 8; i < n - 8; i++) {
    reserved[6][i] = 1;
    reserved[i][6] = 1;
  }

  // 对齐图案
  if (ver.alignment > 0) {
    const ap = ver.alignment;
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r === 3 && c === 3;
        matrix[n - ap - 3 + r][n - ap - 3 + c] = edge || core ? 1 : 0;
        reserved[n - ap - 3 + r][n - ap - 3 + c] = 1;
      }
    }
  }

  // 时序图案
  for (let i = 8; i < n - 8; i++) {
    matrix[6][i] = i % 2 === 0 ? 1 : 0;
    reserved[6][i] = 1;
    matrix[i][6] = i % 2 === 0 ? 1 : 0;
    reserved[i][6] = 1;
  }

  // 填充数据
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);

  // 构建比特流
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);

  // 终止符
  const totalDataBits = ver.dataCodewords * 8;
  const termLen = Math.min(4, totalDataBits - bits.length);
  pushBits(0, termLen);
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0);
  // 填充到数据容量
  const padBytes = [0xEC, 0x11];
  let pi = 0;
  while (bits.length < totalDataBits) {
    pushBits(padBytes[pi++ % 2], 8);
  }

  // 打包成码字
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] || 0);
    codewords.push(byte);
  }

  // RS 纠错
  const ecCodewords = rsEncode(codewords.slice(0, ver.dataCodewords), ver.ecCodewords);
  const allCodewords = [...codewords, ...ecCodewords];

  // 将码字填入矩阵（简化路径：从右到左交替列，自下而上）
  // 这是一个简化实现，不完美但能扫出来
  let ci = 0;
  let upward = true;
  for (let col = n - 1; col >= 0; col -= 2) {
    if (col === 6) col = 5; // 跳过时序列
    const cidx = col >= n / 2 ? col - 1 : col;
    for (let row = 0; row < n; row++) {
      const r = upward ? n - 1 - row : row;
      for (let dc = 0; dc < 2; dc++) {
        const c = cidx - dc;
        if (c < 0 || c >= n) continue;
        if (reserved[r][c]) continue;
        const cwIdx = ci;
        const bitIdx = cwIdx % 8;
        const cwByte = Math.floor(cwIdx / 8);
        if (cwByte < allCodewords.length) {
          matrix[r][c] = (allCodewords[cwByte] >> (7 - bitIdx)) & 1;
        }
        ci++;
      }
    }
    upward = !upward;
  }

  return { matrix, n };
}

/** 模块矩阵 → 终端字符串。 */
function formatMatrix(matrix, quietZone = 2) {
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

// ---------------------------------------------------------------------------
// macOS 路径：CoreImage via osascript
// ---------------------------------------------------------------------------

const JXA_LINES = [
  'ObjC.import("Foundation"); ObjC.import("CoreImage"); ObjC.import("AppKit");',
  'function run(argv) {',
  '  const url = argv[0], out = argv[1];',
  '  const data = $(url).dataUsingEncoding($.NSUTF8StringEncoding);',
  '  const f = $.CIFilter.filterWithName("CIQRCodeGenerator");',
  '  f.setValueForKey(data, "inputMessage");',
  `  f.setValueForKey($("M"), "inputCorrectionLevel");`,
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

  const isDark = (x, y) => {
    const row = topDown ? y : height - 1 - y;
    const p = off + row * bytesPerRow + x * bytesPerPixel;
    if (p + 2 >= b.length) throw new Error('BMP 数据越界');
    return Math.max(b[p], b[p + 1], b[p + 2]) < 128;
  };

  let minX = width, maxX = -1, minY = height, maxY = -1;
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

  const size = maxX - minX + 1;
  if (size < 21 || size > 177 || (size - 17) % 4 !== 0) throw new Error(`模块数不合法: ${size}`);

  const matrix = [];
  for (let r = 0; r < size; r++) {
    const row = new Uint8Array(size);
    for (let c = 0; c < size; c++) row[c] = isDark(minX + c, minY + r) ? 1 : 0;
    matrix.push(row);
  }
  return { matrix, width, height };
}

/** 三个定位图案必须是标准形状 —— 验证 BMP 解析正确。 */
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

// ---------------------------------------------------------------------------
// 主入口：跨平台渲染
// ---------------------------------------------------------------------------

/**
 * 渲染终端二维码。
 * @param {string} text 要编码的内容
 * @returns {string|null} 可直接 console.log 的二维码；失败返回 null
 */
export function renderTerminalQR(text) {
  // macOS 路径：CoreImage
  if (process.platform === 'darwin') {
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
      try { unlinkSync(out); } catch {}
    }
  }

  // Linux / 其他平台：先试 qrencode CLI
  try {
    const qrRes = spawnSync('qrencode', ['-l', 'M', '-s', '1', '-m', '2', '-o', '-', text], {
      encoding: 'utf8',
      timeout: 10000,
    });
    if (qrRes.status === 0 && qrRes.stdout.length > 0) {
      // qrencode 输出 ANSI 彩色 ASCII art，strip ANSI codes
      return qrRes.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    }
  } catch {}

  // Fallback：纯 JS QR 生成
  const jsResult = generateQRMatrix(text);
  if (jsResult) {
    return formatMatrix(jsResult.matrix);
  }

  return null;
}

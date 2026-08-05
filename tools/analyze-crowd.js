/* 开发工具：解析 Chrome 截图的 PNG，并统计观众席区域像素
 * 验证点：1) 观众席在场地两旁确实存在（两侧条带有大量观众色像素）
 *         2) 欢呼侧比普通侧多出手臂像素（观众举起双手）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function decodePNG(buf) {
  if (buf.length < 8) throw new Error('非 PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null;
  if (!channels || bitDepth !== 8) throw new Error('不支持的 PNG 格式 color=' + colorType + ' depth=' + bitDepth);
  const bpp = channels;
  const stride = width * channels;
  const px = Buffer.alloc(height * stride);
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    const row = raw.subarray(p, p + stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = i >= bpp && prev ? prev[i - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = row[i]; break;
        case 1: v = row[i] + a; break;
        case 2: v = row[i] + b; break;
        case 3: v = row[i] + ((a + b) >> 1); break;
        case 4: v = row[i] + paeth(a, b, c); break;
        default: throw new Error('未知滤波 ' + ft);
      }
      out[y * stride + i] = v & 0xff;
    }
    p += stride;
  }
  return { width, height, channels, data: out };
}

// 观众色判定：蓝灰调（b 明显大于 r 且大于 90），非深蓝黑背景、非白线
function isCrowd(r, g, b) {
  return b > 90 && b > r + 14 && b > g + 8;
}

function analyze(img) {
  const { width, height, channels, data } = img;
  const at = (x, y) => {
    const i = (y * width + x) * channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  // 观众区大致 y 150..570；左侧普通半屏 x 0..640，右侧欢呼半屏 x 640..1280
  // 每条带：离屏幕边缘 10..300px（两侧看台投影带）
  function strip(x0, x1, y0, y1) {
    let n = 0, bright = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const [r, g, b] = at(x, y);
        if (isCrowd(r, g, b)) {
          n++;
          if (b > 165 && r > 150) bright++; // 头部/手臂等亮肤色像素
        }
      }
    }
    return { n, bright };
  }
  return {
    normalLeft: strip(10, 300, 150, 570),
    normalRight: strip(340, 630, 150, 570),
    cheerLeft: strip(650, 940, 150, 570),
    cheerRight: strip(980, 1270, 150, 570),
  };
}

const file = process.argv[2];
if (!file) { console.error('用法: node analyze-crowd.js <png>'); process.exit(1); }
const img = decodePNG(fs.readFileSync(file));
const stat = analyze(img);
console.log('观众席像素统计（左=普通半屏，右=欢呼半屏；每半屏取两侧条带）:');
console.log(JSON.stringify(stat, null, 2));
const all = [stat.normalLeft, stat.normalRight, stat.cheerLeft, stat.cheerRight];
const sum = (s) => s.n + s.bright;
const normalSum = sum(stat.normalLeft) + sum(stat.normalRight);
const cheerSum = sum(stat.cheerLeft) + sum(stat.cheerRight);
console.log(`\n普通侧观众像素: ${normalSum}  欢呼侧: ${cheerSum}`);
const okAudience = all.every((s) => s.n > 60);
const okCheer = cheerSum > normalSum * 1.1;
console.log(okAudience ? '✓ 观众席在场地两侧/两端均存在' : '✗ 观众席缺失');
console.log(okCheer ? '✓ 欢呼侧观众像素明显增多（手臂挥舞）' : (cheerSum > normalSum ? '~ 欢呼侧像素略增' : '✗ 欢呼动画未见效果'));
process.exit(okAudience && okCheer ? 0 : 1);

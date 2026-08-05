/* 验证球台投影阴影：桌面周围地板应比远处地板暗
 * 用法: node tools/check-table-shadow.js <截图png>
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const TTG = require(path.join(__dirname, '..', 'public', 'js', 'render.js'));

// ---------- PNG 解码 ----------
function decodePNG(buf) {
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null;
  const bpp = channels, stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
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
      }
      out[y * stride + i] = v & 0xff;
    }
    p += stride;
  }
  return { width, height, channels, data: out };
}

const img = decodePNG(fs.readFileSync(process.argv[2]));
const PW = img.width, PH = img.height;
console.log('截图尺寸:', PW, 'x', PH);
const at = (x, y) => { const i = (Math.round(y) * PW + Math.round(x)) * img.channels; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };

// 复刻游戏相机（AI 模式 side 0：eye y4.8 z-5.2，look y1.7，焦距 0.9vw，画布 1250×625）
// 画布被 CSS 拉伸到截图尺寸 → 投影坐标按比例换算
const CW = 1250, CH = 625;
const cam = new TTG.Camera();
cam.set(TTG.v3(0, 4.8, -5.2), TTG.v3(0, 1.7, 0), CW / 2, CH / 2, CW * 0.9);

// 采样点（阴影带 vs 无影地板）
const samples = {
  shadowSide: { x: 0.85, y: 0.004, z: 0 },  // 台面右侧阴影带（阴影至 x≈0.93）
  shadowFar: { x: 0, y: 0.004, z: 1.5 },    // 台尾阴影带（阴影至 z≈1.67）
  controlSide: { x: 1.6, y: 0.004, z: 0 },  // 台侧远处无影地板
  controlFar: { x: 0, y: 0.004, z: 2.5 },   // 台尾远处无影地板
};

function brightness(p) {
  const q = cam.project(TTG.v3(p.x, p.y, p.z));
  if (!q) return null;
  const px = q.x * PW / CW, py = q.y * PH / CH;
  if (px < 0 || px >= PW || py < 0 || py >= PH) return null;
  const [r, g, b] = at(px, py);
  return { bri: r + g + b, rgb: [r, g, b], px: Math.round(px), py: Math.round(py) };
}

const res = {};
for (const k of Object.keys(samples)) {
  const v = brightness(samples[k]);
  console.log(`  ${k}: ${v ? 'px=' + v.px + ',' + v.py + ' 亮度=' + v.bri + ' ' + JSON.stringify(v.rgb) : '（屏幕外）'}`);
  res[k] = v;
}
const sh = Math.min(
  (res.shadowSide && res.shadowSide.bri) || 1e9,
  (res.shadowFar && res.shadowFar.bri) || 1e9
);
const ctrl = Math.min(
  (res.controlSide && res.controlSide.bri) || 1e9,
  (res.controlFar && res.controlFar.bri) || 1e9
);
console.log(`阴影区最亮 ${sh} vs 无影区最亮 ${ctrl}`);
const ok = Number.isFinite(sh) && sh < ctrl * 0.85;
console.log(ok ? '✓ 球台投影阴影已生效（桌面周围地板更暗）' : '✗ 阴影未见（或采样点偏差）');
process.exit(ok ? 0 : 1);

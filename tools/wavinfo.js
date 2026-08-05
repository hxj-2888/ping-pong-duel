/* 检查 WAV 文件头信息 */
'use strict';
const fs = require('fs');

const file = process.argv[2] || 'C:\\Users\\ASUS\\Desktop\\掌声_游戏版.wav';
const buf = fs.readFileSync(file);
console.log('文件大小:', buf.length, '字节');
if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
  console.log('不是标准 RIFF/WAVE 文件');
  process.exit(1);
}
let off = 12;
let fmt = null, dataSize = -1;
while (off + 8 <= buf.length) {
  const id = buf.toString('ascii', off, off + 4);
  const sz = buf.readUInt32LE(off + 4);
  if (id === 'fmt ') {
    const audioFormat = buf.readUInt16LE(off + 8);
    const channels = buf.readUInt16LE(off + 10);
    const sampleRate = buf.readUInt32LE(off + 12);
    const bits = buf.readUInt16LE(off + 22);
    fmt = { audioFormat, channels, sampleRate, bits };
  } else if (id === 'data') {
    dataSize = sz;
  }
  off += 8 + sz + (sz % 2);
}
if (!fmt) { console.log('缺少 fmt 块'); process.exit(1); }
console.log('音频格式:', fmt.audioFormat === 1 ? 'PCM' : fmt.audioFormat === 3 ? 'IEEE float' : fmt.audioFormat);
console.log('声道数:', fmt.channels);
console.log('采样率:', fmt.sampleRate, 'Hz');
console.log('位深:', fmt.bits, 'bit');
if (dataSize > 0) {
  const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
  console.log('数据块:', dataSize, '字节');
  console.log('时长: ' + (dataSize / bytesPerSec).toFixed(3) + ' 秒');
}

const { execSync } = require('child_process');
const fs = require('fs');
const SRC = 'C:/Users/ASUS/Desktop/乒乓对决_安装包';
const ZIP = 'C:/Users/ASUS/Desktop/乒乓对决_安装包.zip';
// 1) 同步根说明文件
fs.copyFileSync('C:/Users/ASUS/Desktop/乒乓对决_合并/使用说明.txt', SRC + '/使用说明.txt');
console.log('使用说明.txt 已同步');
// 2) 删除旧 zip
fs.rmSync(ZIP, { force: true });
console.log('旧 zip 已删除');
// 3) 重新打包（内容直接打根：game/ node/ bat 使用说明）
const out = execSync('"C:/Program Files/7-Zip/7z.exe" a -tzip "' + ZIP + '" "' + SRC + '\\*" -r', { encoding: 'utf8' });
console.log(out.split('\n').filter((l) => /Everything is Ok|Error/i.test(l)).join('') || '7z done');
// 4) 验证 zip 内游戏为最新
const CHK = 'C:/Users/ASUS/AppData/Local/Temp/pkg_check';
fs.rmSync(CHK, { recursive: true, force: true });
fs.mkdirSync(CHK, { recursive: true });
execSync('"C:/Program Files/7-Zip/7z.exe" e -y -o' + CHK + ' "' + ZIP + '" game/index.html', { encoding: 'utf8' });
const idx = fs.readFileSync(CHK + '/index.html', 'utf8');
console.log('ZIP 内 game/index.html: btnManualMenu=' + idx.includes('btnManualMenu') + ' | btnManualTouch 已移除=' + !idx.includes('btnManualTouch'));
console.log('ZIP 大小:', fs.statSync(ZIP).size);

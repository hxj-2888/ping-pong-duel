/* 养成系统引擎能力测试（v1.8.0）：
 * - ability 字段存在且默认全 0
 * - 快照不含 ability（联机隔离：训练属性不进数据流）
 * - ability.speed 提升移动速度（本地/人机生效的引擎参数化验证）
 */
'use strict';

const TT = require('../public/js/engine.js');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

// 1. ability 字段存在且默认 0
const eng = TT.createEngine();
const a = eng.players[0].ability;
check('createPlayer 含 ability 字段', a && typeof a === 'object');
check('ability 默认全 0', a && a.speed === 0 && a.windup === 0 && a.dur === 0 && a.hitbox === 0);

// 2. 快照不含 ability（联机隔离：服务器只同步位置/比分等，训练属性绝不外发）
const snapStr = JSON.stringify(TT.snapshot(eng));
check('快照不含 ability 字段（联机隔离）', !snapStr.includes('ability'));

// 3. 移动速度加成：ability.speed=5 时相同输入移动更快（约 1.2x）
function moveDist(speedLevel) {
  const s = TT.createEngine();
  s.players[0].ability.speed = speedLevel;
  const startX = s.players[0].padX;
  for (let i = 0; i < 20; i++) {
    TT.setInput(s, 0, { l: 0, r: 1, f: 0, b: 0, pu: 0, sm: 0, crouch: 0, run: 0 });
    TT.step(s, 1 / 60);
  }
  return s.players[0].padX - startX;
}
const d0 = moveDist(0);
const d5 = moveDist(5);
check(`ability.speed=5 移动更快（${d0.toFixed(3)} → ${d5.toFixed(3)}，约 ${(d5 / d0).toFixed(2)}x）`, d5 > d0 * 1.15);

console.log(failures === 0 ? '\n养成能力测试通过 ✓' : `\n${failures} 项失败 ✗`);
process.exitCode = failures === 0 ? 0 : 1;

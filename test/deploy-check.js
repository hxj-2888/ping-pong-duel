/* 验证线上部署为最新版本且健康 */
'use strict';
const https = require('https');
const get = (u) => new Promise((r) => {
  https.get(u, { headers: { 'User-Agent': 'check' } }, (res) => {
    let b = '';
    res.on('data', (c) => b += c);
    res.on('end', () => r({ s: res.statusCode, b }));
  }).on('error', (e) => r({ e: e.message }));
});
(async () => {
  const page = await get('https://ping-pong-duel.pages.dev/');
  console.log('页面  :', page.e ? ('ERR ' + page.e) : ('HTTP ' + page.s + ' 含标题=' + page.b.includes('乒乓对决')));
  const net = await get('https://ping-pong-duel.pages.dev/js/app/net.js');
  console.log('net.js:', net.e ? ('ERR ' + net.e) : ('HTTP ' + net.s + ' 心跳=' + net.b.includes('heartbeatTimer') + ' sideSet=' + net.b.includes('sideSet')));
  const state = await get('https://ping-pong-duel.pages.dev/js/app/state.js');
  console.log('state :', state.e ? ('ERR ' + state.e) : ('HTTP ' + state.s + ' /ws分流=' + state.b.includes('/ws')));
  const main = await get('https://ping-pong-duel.pages.dev/js/app/main.js');
  console.log('main  :', main.e ? ('ERR ' + main.e) : ('HTTP ' + main.s + ' auto=host=' + main.b.includes('auto=host')));
})();

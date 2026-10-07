// PWA：注册 Service Worker（仅 https/localhost 生效；http 的 ECS 端自动跳过，不影响游玩）
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => { /* 非 https 或不受支持：静默 */ });
      });
    }

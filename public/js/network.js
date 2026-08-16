/* network.js — 联机客户端（WebSocket 封装 + 断线重连） */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NetClient = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class NetClient {
    constructor(url, opts) {
      this.url = url;
      this.ws = null;
      this.handlers = {};
      this.connected = false;
      this.closedByUser = false;
      // 握手失败自动重试：DO 冷启动（空闲休眠后首次连接恢复 storage 较慢）或网络瞬断时，
      // 浏览器可能报「WebSocket opening handshake timed out」——自动重连可避免用户手动重试
      this.maxRetries = (opts && opts.maxRetries) || 2; // 首次 + 2 次重试 = 最多 3 次尝试
      this.retryDelay = (opts && opts.retryDelay) || 1200; // 重试间隔（ms），逐次 ×1.5
      this._retries = 0;
      this._retryTimer = null;
      this._pendingIn = null; // v2.7.0-fix:未 OPEN 时缓存的最新输入帧（出站队列，最新覆盖）
    }

    on(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
      return this;
    }

    emit(type, data) {
      for (const fn of this.handlers[type] || []) fn(data);
    }

    connect() {
      this.closedByUser = false;
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        // 同步抛错：多为浏览器"混合内容"拦截（https 页面 new WebSocket('ws://...') 被直接禁止）。
        // 带上真实错误信息，前端可据此给出中文引导（如网页版不能直连局域网）。
        this.emit('error', { e: (e && e.message) || '无法连接服务器' });
        return;
      }
      this.ws = ws;
      const self = this;
      // 回调按 ws 身份过滤：看门狗快速重连（close→connect）时，
      // 旧连接的迟到 open/close/error 事件不得污染新连接的状态（connected 标志等）
      ws.onopen = () => {
        if (self.ws !== ws) return;
        self._openedOnce = true;
        self.connected = true;
        self._retries = 0;
        self.emit('open');
      };
      ws.onmessage = (ev) => {
        if (self.ws !== ws) return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        self.emit(msg.t, msg);
      };
      ws.onclose = () => {
        if (self.ws !== ws) return;
        self.connected = false;
        if (!self.closedByUser) {
          // 未成功打开过（握手失败/超时）且还有重试次数 → 自动重连
          if (self._retries < self.maxRetries && !self._openedOnce) {
            self._retries++;
            const delay = self.retryDelay * Math.pow(1.5, self._retries - 1);
            self.emit('error', { e: `连接失败，${Math.round(delay / 1000)}s 后自动重试（${self._retries}/${self.maxRetries}）` });
            self._retryTimer = setTimeout(() => {
              self._retryTimer = null;
              if (!self.closedByUser) self.connect(); // 重试期间用户可能已手动关闭（返回菜单）
            }, delay);
            return;
          }
          self.emit('close');
        }
      };
      ws.onerror = () => {
        if (self.ws !== ws) return;
        if (self._openedOnce) self.emit('error', { e: '连接出错' });
      };
      // open 后标记已成功打开过（此后 close 不再触发握手重试，走正常断线处理）
      self._openedOnce = false;
    }

    send(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
        if (obj && obj.t === 'in') this._pendingIn = null; // 已送达，清缓存
        return;
      }
      // v2.7.0-fix:未 OPEN（重连/握手窗口）：缓存最新输入帧（最新覆盖，不堆积），
      // 进房后由 flushPending() 补发——避免重连窗口内输入静默丢失导致操作缺口
      if (obj && obj.t === 'in') this._pendingIn = obj;
    }

    // v2.7.0-fix:补发重连/握手期间缓存的输入帧（进房/对局恢复后调用；create/join/ping 不缓存）
    flushPending() {
      if (this._pendingIn && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(this._pendingIn));
        this._pendingIn = null;
      }
    }

    close() {
      this.closedByUser = true;
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
      if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
      this.connected = false;
    }
  }

  return NetClient;
});

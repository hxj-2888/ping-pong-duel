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
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        this.emit('error', { e: '无法连接服务器' });
        return;
      }
      this.ws.onopen = () => {
        this.connected = true;
        this._retries = 0; // 连接成功：重置重试计数
        this.emit('open');
      };
      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        this.emit(msg.t, msg);
      };
      this.ws.onclose = () => {
        this.connected = false;
        if (!this.closedByUser) {
          // 未成功打开过（握手失败/超时）且还有重试次数 → 自动重连
          if (this._retries < this.maxRetries && !this._openedOnce) {
            this._retries++;
            const delay = this.retryDelay * Math.pow(1.5, this._retries - 1);
            this.emit('error', { e: `连接失败，${Math.round(delay / 1000)}s 后自动重试（${this._retries}/${this.maxRetries}）` });
            this._retryTimer = setTimeout(() => {
              this._retryTimer = null;
              if (!this.closedByUser) this.connect(); // 重试期间用户可能已手动关闭（返回菜单）
            }, delay);
            return;
          }
          this.emit('close');
        }
      };
      this.ws.onerror = () => {
        if (this._openedOnce) this.emit('error', { e: '连接出错' });
      };
      this._openedOnce = false;
      // open 后标记已成功打开过（此后 close 不再触发握手重试，走正常断线处理）
      const origOpen = this.ws.onopen;
      this.ws.onopen = () => {
        this._openedOnce = true;
        this.connected = true;
        this._retries = 0;
        origOpen && origOpen();
      };
    }

    send(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
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

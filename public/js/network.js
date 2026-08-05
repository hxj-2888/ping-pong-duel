/* network.js — 联机客户端（WebSocket 封装 + 断线重连） */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NetClient = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class NetClient {
    constructor(url) {
      this.url = url;
      this.ws = null;
      this.handlers = {};
      this.connected = false;
      this.closedByUser = false;
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
        this.emit('open');
      };
      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        this.emit(msg.t, msg);
      };
      this.ws.onclose = () => {
        this.connected = false;
        if (!this.closedByUser) this.emit('close');
      };
      this.ws.onerror = () => {
        this.emit('error', { e: '连接出错' });
      };
    }

    send(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
      }
    }

    close() {
      this.closedByUser = true;
      if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
      this.connected = false;
    }
  }

  return NetClient;
});

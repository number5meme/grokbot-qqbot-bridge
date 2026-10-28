'use strict';
// Preloaded with `--require` (NODE_OPTIONS) in process-level tests: a fake QQ API, webhook and WebSocket
// gateway. No network. HELLO and READY are sent; heartbeats are ACKed.
//  FAKE_C2C        JSON array of C2C events pushed after READY
//  FAKE_WEBHOOK_MS delay before the webhook answers (to test a graceful stop with a message in flight)
//  FAKE_SEND       'ok' (default) or 'refuse': answer for POST /v2/users/{openid}/messages without msg_id
//  FAKE_DUMP       directory: every request is written there as one JSON file (method, url, body)
const fs = require('node:fs');
const path = require('node:path');
let n = 0;
function dump(obj) {
  if (!process.env.FAKE_DUMP) return;
  fs.mkdirSync(process.env.FAKE_DUMP, { recursive: true });
  fs.writeFileSync(path.join(process.env.FAKE_DUMP, `${process.pid}-${Date.now()}-${n++}.json`), JSON.stringify(obj));
}
const json = (status, body) => ({ ok: status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body), type: 'basic' });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  let body; try { body = opts.body ? JSON.parse(opts.body) : undefined; } catch { body = undefined; }
  dump({ method: opts.method || 'GET', url: u, body });
  if (u.includes('getAppAccessToken')) return json(200, { access_token: 'FAKE_TOKEN', expires_in: '7200' });
  if (u.endsWith('/gateway')) return json(200, { url: 'wss://fake.invalid/websocket' });
  if (/\/v2\/users\/[^/]+\/files$/.test(u)) return json(200, { file_uuid: 'FU', file_info: 'FAKE_FILE_INFO', ttl: 3600 });
  if (/\/v2\/users\/[^/]+\/messages$/.test(u)) {
    if (process.env.FAKE_SEND === 'refuse' && !(body && body.msg_id)) return json(400, { code: 40034100, message: 'active message refused' });
    return json(200, { id: `R${n}`, timestamp: 1 });
  }
  if (u.startsWith('https://hook')) {
    const ms = Number(process.env.FAKE_WEBHOOK_MS) || 0;
    if (ms) await new Promise((r) => setTimeout(r, ms));
    return json(200, { ok: true });
  }
  return json(404, {});
};

class FakeGatewayWS {
  constructor(url) {
    this.url = url; this.readyState = 0; this.listeners = {};
    setImmediate(() => { this.readyState = 1; this.emit('open'); this.push({ op: 10, d: { heartbeat_interval: 30000 } }); });
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  emit(t, ev = {}) { for (const fn of this.listeners[t] || []) fn(ev); }
  push(o) { setImmediate(() => this.emit('message', { data: JSON.stringify(o) })); }
  send(s) {
    const m = JSON.parse(s);
    if (m.op === 1) this.push({ op: 11 });
    if (m.op === 2 || m.op === 6) {
      this.push({ op: 0, s: 1, t: m.op === 2 ? 'READY' : 'RESUMED', d: { session_id: 'FAKE_SESSION', user: { id: 'bot' } } });
      const events = JSON.parse(process.env.FAKE_C2C || '[]');
      events.forEach((d, i) => this.push({ op: 0, s: 2 + i, t: 'C2C_MESSAGE_CREATE', d }));
    }
  }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; setImmediate(() => this.emit('close', { code, reason: '' })); }
}
globalThis.WebSocket = FakeGatewayWS;

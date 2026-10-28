'use strict';
// Offline fakes: scripted fetch, a controllable WebSocket, and an in-memory store. No network, no ports.

/** handler(call, n) -> { status, body } | { throw: 'TypeError' } | undefined */
function makeFetch(handler) {
  const calls = [];
  const f = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    const spec = (await handler(call, calls.length)) || { status: 200, body: {} };
    if (spec.throw) throw Object.assign(new Error('net'), { name: spec.throw });
    const status = spec.status || 200;
    return { ok: status < 300, status, text: async () => (spec.raw ?? JSON.stringify(spec.body ?? {})) };
  };
  f.calls = calls;
  return f;
}

class FakeWS {
  constructor(url) {
    this.url = url; this.sent = []; this.listeners = {}; this.readyState = 0;
    FakeWS.instances.push(this);
    if (FakeWS.onCreate) setImmediate(() => FakeWS.onCreate(this));
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  emit(t, ev = {}) { for (const fn of this.listeners[t] || []) fn(ev); }
  send(s) { if (this.sendThrows && this.sendThrows(JSON.parse(s))) throw new Error('socket broken'); this.sent.push(JSON.parse(s)); if (this.onSend) this.onSend(JSON.parse(s)); }
  close(code = 1000) { this.closedByClient = code; if (this.halfOpen || this.readyState === 3) return; this.readyState = 3; setImmediate(() => this.emit('close', { code, reason: '' })); }
  // server-side helpers
  open() { this.readyState = 1; this.emit('open'); }
  push(obj) { this.emit('message', { data: JSON.stringify(obj) }); }
  serverClose(code, reason = '') { this.readyState = 3; this.emit('close', { code, reason }); }
}
FakeWS.instances = [];
FakeWS.onCreate = null;

function memStore(init = {}) {
  const s = { seen: init.seen || [], lastMsgs: {}, lastSender: null, undelivered: [], session: init.session || null, seq: init.seq || {} };
  return {
    s,
    loadSeen: () => s.seen.slice(), saveSeen: (a) => { s.seen = a.slice(); },
    saveLastMsg: (id, o) => { s.lastMsgs[id] = o; }, getLastMsg: (id) => s.lastMsgs[id] || null,
    saveLastSender: (id) => { s.lastSender = id; }, getLastSender: () => s.lastSender,
    appendUndelivered: (o) => s.undelivered.push(o),
    loadSession: () => s.session, saveSession: (x) => { s.session = { ...x }; }, clearSession: () => { s.session = {}; },
    getSeq: () => JSON.parse(JSON.stringify(s.seq)), saveSeq: (o) => { s.seq = JSON.parse(JSON.stringify(o)); },
  };
}
function memOwner(init = null) { let o = init; return { get: () => o, set: (id) => { o = id; }, peek: () => o }; }

module.exports = { makeFetch, FakeWS, memStore, memOwner };

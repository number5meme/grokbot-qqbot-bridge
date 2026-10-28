'use strict';
// Host suspend / pause recovery for the QQ gateway: clock jumps, frozen or lost timers, requests and sockets that
// never settle. No network: fetch and WebSocket are faked; clocks are injected.
const test = require('node:test');
const assert = require('node:assert');
const Q = require('../src/qq');
const { Gateway, abortableSleep } = require('../src/gateway');
const { ClockJumpDetector } = require('../src/clock');
const { Backoff } = require('../src/backoff');
const { FakeWS, memStore } = require('./fakes');

const zeroBackoff = () => new Backoff({ baseMs: 1000, maxMs: 60_000, random: () => 0 });
const res = (body, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
const hang = (signal) => new Promise((_, reject) => {
  if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
});

/** fetch whose /gateway behavior is scripted per call: 'ok' | 'hang' | 'hang-ignore-signal' | 'stall-body' | 'net'. */
function scriptedFetch(script) {
  const calls = { token: 0, gateway: 0 };
  const f = async (url, opts = {}) => {
    if (url === Q.TOKEN_URL) { calls.token++; return res({ access_token: 'TOK', expires_in: '7200' }); }
    if (String(url).endsWith('/gateway')) {
      calls.gateway++;
      const s = script.shift() || 'ok';
      if (s === 'hang') return hang(opts.signal);
      if (s === 'hang-ignore-signal') return new Promise(() => {});
      if (s === 'stall-body') return { ok: true, status: 200, text: () => new Promise(() => {}) };
      if (s === 'net') throw new TypeError('fetch failed');
      return res({ url: 'wss://fake/websocket' });
    }
    return res({}, 404);
  };
  f.calls = calls;
  return f;
}

/** Each socket answers HELLO; IDENTIFY -> READY, RESUME -> RESUMED; then the test closes with 4914 to end run(). */
function serverScript({ silent = [] } = {}) {
  FakeWS.instances = [];
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    if (silent.includes(idx)) return; // never opens, never sends HELLO (e.g. SYN lost after a resume)
    ws.onSend = (m) => {
      if (m.op === 1) ws.push({ op: 11 });
      if (m.op === 2) ws.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'S1' } });
      if (m.op === 6) { ws.push({ op: 0, s: 9, t: 'RESUMED', d: '' }); setTimeout(() => ws.serverClose(4914), 5); }
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 60_000 } });
  };
}

function mkGw(fetchImpl, opts = {}) {
  const logs = []; const delays = [];
  const tokens = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl });
  const store = opts.store || memStore({ session: { session_id: 'S1', seq: 5 } });
  const gw = new Gateway({ tokens, onC2C: async () => {}, store, fetchImpl, WebSocketImpl: FakeWS, logFn: (m) => logs.push(m),
    sleep: (ms, signal) => { delays.push(ms); return abortableSleep(Math.min(ms, 5), signal); }, hbJitterMaxMs: 5,
    backoff: zeroBackoff(), clock: null, ...opts });
  return { gw, logs, delays, tokens };
}
const fatalBanned = (e) => e.fatal === Q.FATAL.BANNED;

test('clock detector: wall-clock jump (suspend) and late monotonic tick (frozen timers) both report; normal ticks do not', () => {
  let t = 0; let m = 0; const jumps = [];
  const d = new ClockJumpDetector({ intervalMs: 5000, thresholdMs: 30_000, now: () => t, mono: () => m, onJump: (x) => jumps.push(x) });
  d.last = 0; d.lastMono = 0;
  t += 5000; m += 5000; assert.strictEqual(d.tick(), 0);
  t += 5000 + 300_000; m += 5000; assert.strictEqual(d.tick(), 300_000);   // suspend: monotonic stopped, wall clock did not
  t += 65_000; m += 65_000; assert.strictEqual(d.tick(), 60_000);           // VM pause / cgroup freeze: timer fired 60 s late
  t += 4000; m += 4000; assert.strictEqual(d.tick(), 0);
  assert.deepStrictEqual(jumps, [300_000, 60_000]);
});

test('incident replay: stale close -> "reconnecting in 1s" -> host sleeps (timer frozen) -> clock jump reconnects at once', async () => {
  // Socket 0 goes silent (stale). The 1 s backoff sleep then never fires on its own (frozen timer); only the
  // clock jump after the resume may end it.
  FakeWS.instances = [];
  let gwRef = null; let frozen = 0;
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    ws.onSend = (m) => {
      if (idx === 0 && m.op === 6) { ws.push({ op: 0, s: 6, t: 'RESUMED', d: '' }); setTimeout(() => gwRef.conn.closeLocal('stale'), 5); }
      if (idx === 1 && m.op === 6) { ws.push({ op: 0, s: 7, t: 'RESUMED', d: '' }); setTimeout(() => ws.serverClose(4914), 5); }
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 60_000 } });
  };
  const fetchImpl = scriptedFetch([]);
  const { gw, logs } = mkGw(fetchImpl, {
    sleep: (ms, signal) => { frozen++; setTimeout(() => gwRef.onClockJump(310_000), 20); return abortableSleep(3_600_000, signal); },
  });
  gwRef = gw;
  const t0 = Date.now();
  await assert.rejects(gw.run(), fatalBanned);
  assert.ok(Date.now() - t0 < 2000, 'did not wait for the frozen timer');
  assert.strictEqual(frozen, 1);
  assert.ok(logs.some((l) => /^reconnecting in 1\.0s \(resume\)$/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /^clock jump detected \(310s/.test(l)));
  assert.strictEqual(FakeWS.instances.length, 2);
  assert.deepStrictEqual(FakeWS.instances[1].sent.find((x) => x.op === 6).d.seq, 6, 'RESUME on the new socket');
  FakeWS.onCreate = null;
});

test('clock jump while the /gateway request hangs: request aborted, fresh attempt right away, RESUME', async () => {
  serverScript();
  const fetchImpl = scriptedFetch(['hang']);
  let gwRef = null;
  const { gw, logs, delays } = mkGw(fetchImpl, { requestTimeoutMs: 60_000 });
  gwRef = gw;
  setTimeout(() => gwRef.onClockJump(300_000), 30);
  await assert.rejects(gw.run(), fatalBanned);
  assert.strictEqual(fetchImpl.calls.gateway, 2);
  assert.ok(logs.some((l) => l === 'connect attempt interrupted (clock_jump)'), logs.join('\n'));
  assert.ok(logs.some((l) => /^reconnecting now after wake-up \(clock_jump, resume\)$/.test(l)));
  assert.strictEqual(delays[0], 0);
  assert.ok(FakeWS.instances[0].sent.some((x) => x.op === 6));
  FakeWS.onCreate = null;
});

test('request timeouts cover a fetch that ignores its signal and a body that stalls after the headers', async () => {
  const f1 = async () => new Promise(() => {});
  await assert.rejects(Q.apiRequest({ method: 'GET', path: '/gateway', token: 'T', fetchImpl: f1, timeoutMs: 30 }), (e) => e.platformMessage === 'timeout');
  const f2 = async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) });
  await assert.rejects(Q.apiRequest({ method: 'GET', path: '/gateway', token: 'T', fetchImpl: f2, timeoutMs: 30 }), (e) => e.platformMessage === 'timeout');
  const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(Q.apiRequest({ method: 'GET', path: '/gateway', token: 'T', fetchImpl: f1, timeoutMs: 60_000, signal: ctrl.signal }));
  // token request too
  const tm = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: f2 });
  const c2 = new AbortController(); setTimeout(() => c2.abort(), 10);
  await assert.rejects(tm.get({ signal: c2.signal }), (e) => e.platformMessage === 'timeout');
  assert.strictEqual(tm.pending, null);
});

test('stalled /gateway body and a fetch ignoring its signal: gateway times out and retries until it connects', async () => {
  serverScript();
  const fetchImpl = scriptedFetch(['stall-body', 'hang-ignore-signal', 'net']);
  const { gw, logs, delays } = mkGw(fetchImpl, { requestTimeoutMs: 30 });
  await assert.rejects(gw.run(), fatalBanned);
  assert.strictEqual(fetchImpl.calls.gateway, 4);
  assert.strictEqual(logs.filter((l) => l.startsWith('connect error:')).length, 3, logs.join('\n'));
  assert.deepStrictEqual(delays.slice(0, 3), [1000, 2000, 4000]);
  FakeWS.onCreate = null;
});

test('websocket that never sends HELLO is dropped after connectTimeoutMs and the next attempt connects', async () => {
  serverScript({ silent: [0] });
  const fetchImpl = scriptedFetch([]);
  const { gw, logs } = mkGw(fetchImpl, { connectTimeoutMs: 40 });
  await assert.rejects(gw.run(), fatalBanned);
  assert.ok(logs.some((l) => /^ws: no HELLO within/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => l.includes('local=connect_timeout')));
  assert.strictEqual(FakeWS.instances.length, 2);
  assert.ok(FakeWS.instances[1].sent.some((x) => x.op === 6));
  FakeWS.onCreate = null;
});

test('lost timer: a step that never settles (frozen sleep, no clock jump) is broken by the watchdog tick', async () => {
  serverScript();
  const fetchImpl = scriptedFetch(['net']);
  let m = 0;
  const { gw, logs } = mkGw(fetchImpl, {
    mono: () => m, watchdogEveryMs: 10, stepMarginMs: 1000,
    // the backoff sleep's own timer is lost: only an abort can end it
    sleep: (ms, signal) => { setTimeout(() => { m += ms + 5000; }, 15); return abortableSleep(3_600_000, signal); },
  });
  await assert.rejects(gw.run(), fatalBanned);
  assert.ok(logs.some((l) => /^watchdog: backoff sleep did not finish within \d+s, forcing a fresh reconnect$/.test(l)), logs.join('\n'));
  assert.strictEqual(fetchImpl.calls.gateway, 2);
  FakeWS.onCreate = null;
});

test('watchdog: a /gateway request stuck beyond its bound is abandoned even if its timeout never fires', async () => {
  serverScript();
  const fetchImpl = scriptedFetch(['hang']);
  let m = 0;
  const { gw, logs } = mkGw(fetchImpl, { mono: () => m, watchdogEveryMs: 10, requestTimeoutMs: 3_600_000, stepMarginMs: 1000 });
  setTimeout(() => { m += 3_700_000; }, 20);
  await assert.rejects(gw.run(), fatalBanned);
  assert.ok(logs.some((l) => /^watchdog: gateway url request did not finish/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => l === 'connect attempt interrupted (stuck)'));
  FakeWS.onCreate = null;
});

test('reconnects retry forever with backoff capped at 60 s; a wake-up resets the backoff', async () => {
  serverScript();
  const fetchImpl = scriptedFetch(Array(12).fill('net'));
  let gwRef = null; let n = 0;
  const { gw, delays } = mkGw(fetchImpl, {
    sleep: (ms, signal) => { delays.push(ms); if (++n === 10) gwRef.wake('test'); return abortableSleep(1, signal); },
  });
  gwRef = gw;
  await assert.rejects(gw.run(), fatalBanned);
  assert.strictEqual(fetchImpl.calls.gateway, 13);
  assert.deepStrictEqual(delays.slice(0, 9), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.strictEqual(delays[10], 1000, 'backoff starts again at 1 s after the wake-up');
  assert.strictEqual(gw.stats.wakes, 1);
  FakeWS.onCreate = null;
});

test('wake-up on a live connection drops the socket without waiting for a close (half-open) and resumes', async () => {
  FakeWS.instances = [];
  let gwRef = null;
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    if (idx === 0) ws.halfOpen = true; // close() never confirmed
    ws.onSend = (m) => {
      if (m.op === 1) ws.push({ op: 11 });
      if (idx === 0 && m.op === 6) { ws.push({ op: 0, s: 6, t: 'RESUMED', d: '' }); setTimeout(() => gwRef.onClockJump(-120_000), 10); }
      if (idx === 1 && m.op === 6) { ws.push({ op: 0, s: 7, t: 'RESUMED', d: '' }); setTimeout(() => ws.serverClose(4914), 5); }
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 60_000 } });
  };
  const fetchImpl = scriptedFetch([]);
  const { gw, logs } = mkGw(fetchImpl, { closeFallbackMs: 60_000 });
  gwRef = gw;
  const t0 = Date.now();
  await assert.rejects(gw.run(), fatalBanned);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(logs.some((l) => l === 'ws closed code=1000 local=clock_jump (dropped without waiting)'), logs.join('\n'));
  assert.ok(!logs.some((l) => l.includes('half-open')));
  // late events from the dropped socket are ignored
  FakeWS.instances[0].push({ op: 0, s: 99, t: 'C2C_MESSAGE_CREATE', d: {} });
  assert.strictEqual(gw.seq, 7);
  FakeWS.onCreate = null;
});

test('expired token after a long suspend is fetched again before reconnecting', async () => {
  serverScript();
  let wall = 1_000_000;
  const fetchImpl = scriptedFetch([]);
  const tokens = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl, now: () => wall });
  await tokens.get();
  assert.strictEqual(fetchImpl.calls.token, 1);
  wall += 3 * 3600_000; // slept 3 h, token lifetime is 2 h
  const gw = new Gateway({ tokens, onC2C: async () => {}, store: memStore({ session: { session_id: 'S1', seq: 5 } }), fetchImpl, WebSocketImpl: FakeWS,
    sleep: (ms, s) => abortableSleep(1, s), hbJitterMaxMs: 5, backoff: zeroBackoff(), clock: null });
  await assert.rejects(gw.run(), fatalBanned);
  assert.strictEqual(fetchImpl.calls.token, 2);
  FakeWS.onCreate = null;
});

test('stop during a hanging request ends run() promptly', async () => {
  serverScript();
  const ctrl = new AbortController();
  const fetchImpl = scriptedFetch(['hang-ignore-signal']);
  const { gw } = mkGw(fetchImpl, { signal: ctrl.signal, requestTimeoutMs: 3_600_000 });
  setTimeout(() => ctrl.abort(), 20);
  const t0 = Date.now();
  await gw.run();
  assert.ok(Date.now() - t0 < 1000);
  FakeWS.onCreate = null;
});

test('healthcheck: STALE held back briefly after a wake-up only if the bridge was healthy before the sleep', () => {
  const { evaluateHealth, EXIT, WAKE_GRACE_SECONDS } = require('../src/health');
  const now = 10_000_000; const fatal = {};
  // healthy until the host slept for 300 s; woke 5 s ago; heartbeat 310 s old by wall clock
  const base = { pidAlive: true, status: 'RECONNECTING', heartbeatMs: now - 310_000, nowMs: now, staleSeconds: 180 };
  assert.strictEqual(evaluateHealth(base, fatal).code, EXIT.STALE, 'no wake-up recorded');
  const rec = evaluateHealth({ ...base, wakeMs: now - 5000, wakeDriftMs: 300_000 }, fatal);
  assert.strictEqual(rec.code, EXIT.OK);
  assert.match(rec.reason, /^recovering after a host wake-up 5s ago/);
  assert.strictEqual(evaluateHealth({ ...base, wakeMs: now - (WAKE_GRACE_SECONDS + 1) * 1000, wakeDriftMs: 300_000 }, fatal).code, EXIT.STALE,
    'no recovery within the grace period -> restart');
  assert.strictEqual(evaluateHealth({ ...base, pidAlive: false, wakeMs: now - 5000, wakeDriftMs: 300_000 }, fatal).code, EXIT.NOT_RUNNING);
  // a dead bridge with recurring wake-ups (e.g. paused every minute): already stale before the last sleep -> no grace
  const dead = { ...base, heartbeatMs: now - 900_000, wakeMs: now - 5000, wakeDriftMs: 60_000 };
  assert.strictEqual(evaluateHealth(dead, fatal).code, EXIT.STALE);
  // a watchdog 'stuck' wake-up (no sleep) does not extend a stale heartbeat
  assert.strictEqual(evaluateHealth({ ...base, wakeMs: now - 5000, wakeDriftMs: 0 }, fatal).code, EXIT.STALE);
  // wake time in the future (clock set back) gives no grace
  assert.strictEqual(evaluateHealth({ ...base, wakeMs: now + 60_000, wakeDriftMs: 400_000 }, fatal).code, EXIT.STALE);
});

test('clock detector: monotonic-only lateness (frozen timers, wall clock stepped back meanwhile) is reported', () => {
  let t = 0; let m = 0; const jumps = [];
  const d = new ClockJumpDetector({ intervalMs: 5000, thresholdMs: 30_000, now: () => t, mono: () => m, onJump: (x) => jumps.push(x) });
  d.last = 0; d.lastMono = 0;
  t += 5000; m += 65_000; // timers frozen 60 s, and NTP stepped the wall clock back by the same amount
  assert.strictEqual(d.tick(), 60_000);
  t += 5000 + 25_000; m += 5000; // 25 s step: below the threshold, ignored
  assert.strictEqual(d.tick(), 0);
  t += 5000; m += 5000 + 29_000; // 29 s event-loop stall: below the threshold, ignored (no reconnect loop under load)
  assert.strictEqual(d.tick(), 0);
  assert.deepStrictEqual(jumps, [60_000]);
});

test('wake-up after stop or outside run() does nothing (no reconnect, no health write)', async () => {
  serverScript();
  const ctrl = new AbortController(); const wakes = [];
  const fetchImpl = scriptedFetch(['hang']);
  const { gw } = mkGw(fetchImpl, { signal: ctrl.signal, onWake: (r) => wakes.push(r) });
  gw.onClockJump(300_000); // before run()
  const p = gw.run();
  await new Promise((r) => setTimeout(r, 20));
  ctrl.abort();
  gw.onClockJump(300_000); // during stop
  await p;
  gw.wake('late'); // after run()
  assert.deepStrictEqual(wakes, []);
  assert.strictEqual(fetchImpl.calls.gateway, 1, 'no new attempt after stop');
  FakeWS.onCreate = null;
});

test('a server-mandated delay (4008 rate limit) is not cut short by a wake-up', async () => {
  FakeWS.instances = [];
  let gwRef = null;
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    ws.onSend = (m) => { if (m.op === 6) setImmediate(() => ws.serverClose(idx === 0 ? 4008 : 4914)); };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 60_000 } });
  };
  const ends = [];
  const fetchImpl = scriptedFetch([]);
  const { gw } = mkGw(fetchImpl, {
    sleep: (ms, signal) => { setTimeout(() => gwRef.wake('test'), 5); return abortableSleep(80, signal).then(() => ends.push(signal.aborted)); },
  });
  gwRef = gw;
  await assert.rejects(gw.run(), fatalBanned);
  assert.deepStrictEqual(ends, [false], '4008 sleep ran to its end despite the wake-up');
  FakeWS.onCreate = null;
});

test('linkSignals: aborts with any source and leaves no listener behind after dispose', () => {
  const { getEventListeners } = require('node:events');
  const { linkSignals } = require('../src/gateway');
  const stop = new AbortController();
  for (let i = 0; i < 100; i++) { const l = linkSignals([stop.signal, new AbortController().signal]); l.dispose(); }
  assert.strictEqual(getEventListeners(stop.signal, 'abort').length, 0);
  const a = new AbortController(); const l = linkSignals([stop.signal, a.signal]);
  a.abort(); assert.ok(l.signal.aborted); l.dispose();
  const pre = new AbortController(); pre.abort();
  assert.ok(linkSignals([pre.signal]).signal.aborted);
});

test('stale detection uses the monotonic clock: a wall-clock step does not drop a healthy socket', async () => {
  FakeWS.instances = [];
  let offset = 0;
  FakeWS.onCreate = (ws) => {
    ws.onSend = (m) => {
      if (m.op === 1) { ws.push({ op: 11 }); offset += 3_600_000; } // the wall clock jumps an hour on every heartbeat
      if (m.op === 6) ws.push({ op: 0, s: 6, t: 'RESUMED', d: '' });
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 20 } });
    setTimeout(() => ws.serverClose(4914), 200);
  };
  const fetchImpl = scriptedFetch([]);
  const { gw, logs } = mkGw(fetchImpl, { now: () => Date.now() + offset, watchdogEveryMs: 10, watchdogStaleMs: 150 });
  await assert.rejects(gw.run(), fatalBanned);
  assert.strictEqual(FakeWS.instances.length, 1, logs.join('\n'));
  assert.ok(!logs.some((l) => /local=(stale|watchdog)/.test(l)));
  assert.ok(gw.stats.hbAcked >= 5);
  FakeWS.onCreate = null;
});

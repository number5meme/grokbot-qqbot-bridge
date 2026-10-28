'use strict';
// QQ Bot WebSocket gateway client (outbound WSS only) with anti-disconnect hardening:
//  - heartbeats start right after HELLO and every heartbeat_interval after that;
//  - stale detection: if no frame or ACK arrives for about 2 heartbeat intervals, or 2 heartbeats in a row
//    are not ACKed, the socket is closed and the session is RESUMEd on a new connection;
//  - half-open sockets: if close() is never confirmed, the socket is abandoned after closeFallbackMs;
//  - suspend/resume: a wall-clock jump (e.g. the host slept) forces a reconnect, because sockets often stay
//    ESTABLISHED after a resume but never deliver events again;
//  - wake-up (clock jump / frozen timers, see clock.js): the socket is dropped at once (not waited for), any
//    in-flight token or /gateway request and any backoff sleep is aborted, the backoff is reset, and a fresh
//    connection is made right away (RESUME if a session is known, else IDENTIFY; token re-fetched if expired);
//  - every step has a bound: token and /gateway requests (headers and body) time out, a socket that never delivers
//    HELLO is dropped after connectTimeoutMs, a close that is never confirmed is abandoned after closeFallbackMs;
//  - a watchdog tick (every watchdogEveryMs, monotonic clock) forces a resume if a live socket received no frame for
//    watchdogStaleMs, and forces a fresh attempt if any step (token, gateway, handshake, sleep) overran its bound;
//  - reconnects (including after op 9 INVALID_SESSION) retry forever with exponential backoff and jitter
//    (1 s .. 60 s), reset after READY/RESUMED and on wake-up;
//  - fatal close codes (4914/4915 banned or delisted, 4013/4014 intents) and fatal API errors stop the loop.
const Q = require('./qq');
const { Backoff } = require('./backoff');
const { performance } = require('node:perf_hooks');
const { ClockJumpDetector } = require('./clock');

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };

class FatalError extends Error {
  constructor(fatal, why) { super(`${fatal.status}: ${why}`); this.fatal = fatal; }
}

function decodeData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return '';
}

/** Decide what to do after a socket close: { fatal?, clearSession, refreshToken, delayMs? }. */
function closeAction(code) {
  if (code === 4914 || code === 4915) return { fatal: Q.FATAL.BANNED };
  if (code === 4013 || code === 4014) return { fatal: Q.FATAL.INTENT_DENIED };
  if (code === 4004) return { clearSession: false, refreshToken: true };
  if (code === 4008) return { clearSession: false, refreshToken: false, delayMs: 60_000 };
  if (code === 4009) return { clearSession: false, refreshToken: true };
  if (code === 4006 || code === 4007 || (code >= 4900 && code <= 4913)) return { clearSession: true, refreshToken: true };
  if (code >= 4001 && code <= 4012) return { clearSession: true, refreshToken: false };
  return { clearSession: false, refreshToken: false }; // 1000/1005/1006 etc: plain reconnect + resume
}

const LOCAL_REASONS_RESUME = new Set(['reconnect', 'zombie', 'stale', 'watchdog', 'clock_jump', 'wake', 'stuck']);
// Reasons for which the socket is dropped immediately instead of waiting for a close confirmation.
const ABANDON_REASONS = new Set(['clock_jump', 'wake', 'stuck', 'connect_timeout']);
const STEP_MARGIN_MS = 30_000; // extra time a step may take beyond its own timeout before the watchdog intervenes

/** setTimeout-based sleep that ends early when signal aborts. */
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const done = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}
/**
 * A signal that aborts when any of `signals` aborts, plus dispose() to detach from them. Used instead of
 * AbortSignal.any so nothing stays registered on the long-lived stop signal after each attempt or sleep.
 */
function linkSignals(signals) {
  const list = signals.filter(Boolean);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  for (const s of list) { if (s.aborted) { ctrl.abort(); break; } }
  if (!ctrl.signal.aborted) for (const s of list) s.addEventListener('abort', onAbort, { once: true });
  return { signal: ctrl.signal, dispose: () => { for (const s of list) s.removeEventListener('abort', onAbort); } };
}

class Gateway {
  /**
   * store: { loadSession(), saveSession({session_id, seq}), clearSession() }
   * onAlive(): called on every received frame (used for the health heartbeat file)
   * onState(word): 'RUNNING' after READY/RESUMED, 'RECONNECTING' before a reconnect
   * onWake(reason): a wake-up forced a fresh reconnect ('clock_jump', 'stuck', ...)
   * Timing knobs are injectable for tests.
   */
  constructor({ tokens, onC2C, store, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, logFn = () => {},
    sleep = abortableSleep, intents = Q.INTENT_GROUP_AND_C2C, apiBase = Q.API_BASE, signal,
    now = Date.now, mono = () => performance.now(), backoff = new Backoff({ baseMs: 1000, maxMs: 60_000 }), onAlive = () => {}, onState = () => {}, onWake = () => {},
    hbJitterMaxMs = 2000, staleFactor = 1.5, summaryFirstMs = 2 * 60_000, summaryEveryMs = 10 * 60_000,
    watchdogEveryMs = 10_000, watchdogStaleMs = 5 * 60_000, closeFallbackMs = 5000, connectTimeoutMs = 30_000,
    requestTimeoutMs = 15_000, stepMarginMs = STEP_MARGIN_MS,
    clock = { intervalMs: 5000, thresholdMs: 30_000 } }) {
    Object.assign(this, { tokens, onC2C, store, fetchImpl, WebSocketImpl, logFn, sleep, intents, apiBase, signal, now, backoff,
      onAlive, onState, hbJitterMaxMs, staleFactor, summaryFirstMs, summaryEveryMs, watchdogEveryMs, watchdogStaleMs, closeFallbackMs, clock,
      mono, connectTimeoutMs, requestTimeoutMs, stepMarginMs, onWake });
    const s = store.loadSession() || {};
    this.sessionId = s.session_id || null;
    this.seq = Number.isFinite(s.seq) ? s.seq : null;
    this.ws = null;
    this.conn = null;
    this.stats = { hbSent: 0, hbAcked: 0, frames: 0, dispatches: 0, reconnects: 0, clockJumps: 0, wakes: 0 };
    this.step = null;      // { name, since (monotonic), limitMs }: what the loop is waiting on right now
    this.wakeCtrl = null;  // aborted to interrupt the current attempt (request, handshake or sleep)
    this.wakeReason = null;
  }
  saveSession() { if (this.sessionId) this.store.saveSession({ session_id: this.sessionId, seq: this.seq }); }
  clearSession() { this.sessionId = null; this.seq = null; this.store.clearSession(); }

  /** Called by the clock detector (or tests). */
  onClockJump(driftMs) {
    this.stats.clockJumps++;
    this.logFn(`clock jump detected (${Math.round(driftMs / 1000)}s, host suspend or clock change), forcing reconnect`);
    this.wake('clock_jump', driftMs);
  }

  /**
   * Force an immediate fresh connection attempt from whatever state the loop is in: drop the socket, abort a
   * pending token / gateway request or backoff sleep, reset the backoff.
   */
  wake(reason = 'wake', driftMs = 0) {
    if ((this.signal && this.signal.aborted) || !this.wakeCtrl) return; // stopping, or run() is not active
    this.stats.wakes++;
    this.backoff.reset();
    this.wakeReason = reason;
    try { this.onWake(reason, driftMs); } catch { /* ignore */ }
    const c = this.conn;
    if (c && !c.done) c.closeLocal(reason);
    if (this.wakeCtrl && !this.wakeCtrl.signal.aborted) this.wakeCtrl.abort();
  }

  setStep(name, limitMs) { this.step = { name, since: this.mono(), limitMs }; }

  /** Main loop. Resolves when signal aborts; rejects with FatalError. */
  async run() {
    const wd = setInterval(() => this.watchdogTick(), this.watchdogEveryMs);
    wd.unref?.();
    const detector = this.clock ? new ClockJumpDetector({ ...this.clock, onJump: (d) => this.onClockJump(d) }).start() : null;
    try {
      while (!(this.signal && this.signal.aborted)) {
        const wake = new AbortController();
        this.wakeCtrl = wake; this.wakeReason = null;
        let result;
        try {
          result = await this.connectOnce(wake.signal);
        } catch (e) {
          const f = Q.fatalOf(e);
          if (f) throw new FatalError(f, e.message);
          if (this.signal && this.signal.aborted) break;
          if (wake.signal.aborted) {
            this.logFn(`connect attempt interrupted (${this.wakeReason || 'wake'})`);
            result = { code: 0, delayMs: 0 };
          } else {
            if (Q.isAuthError(e)) this.tokens.invalidate();
            this.logFn(`connect error: ${e.message}${e.platformMessage ? ' (' + Q.preview(e.platformMessage, 60) + ')' : ''}`);
            result = { code: 0, delayMs: null };
          }
        }
        if (this.signal && this.signal.aborted) break;
        if (result.fatal) throw new FatalError(result.fatal, `close code ${result.code}`);
        const delay = result.delayMs ?? this.backoff.next();
        // A delay the server asked for (4008 rate limit, op 9) is honored even if a wake-up happens meanwhile.
        const serverDelay = Boolean(result.serverDelay);
        this.stats.reconnects++;
        this.onState('RECONNECTING');
        const mode = this.sessionId ? 'resume' : 'identify';
        if (wake.signal.aborted) this.logFn(`reconnecting now after wake-up (${this.wakeReason || 'wake'}, ${mode})`);
        else this.logFn(`reconnecting in ${(delay / 1000).toFixed(1)}s (${mode})`);
        this.setStep('backoff sleep', delay + this.stepMarginMs);
        // A wake-up (clock jump, watchdog) or stop ends a backoff sleep early; stop also ends a server-mandated one.
        const link = linkSignals(serverDelay ? [this.signal] : [wake.signal, this.signal]);
        try { await this.sleep(delay, link.signal); } finally { link.dispose(); }
      }
    } finally { clearInterval(wd); if (detector) detector.stop(); this.step = null; this.wakeCtrl = null; }
  }

  /**
   * Watchdog tick: (1) a live connection that received no frame for watchdogStaleMs is resumed; (2) a step of the
   * connect loop that overran its bound (a request, handshake or sleep that never settled, e.g. because a timer
   * was lost across a host suspend) forces a fresh attempt. Durations use the monotonic clock.
   */
  watchdogTick() {
    const c = this.conn;
    if (c && !c.done && c.interval) {
      const age = this.mono() - c.lastFrameAt;
      if (age > this.watchdogStaleMs) {
        this.logFn(`watchdog: no gateway frame for ${Math.round(age / 1000)}s, forcing resume`);
        c.closeLocal('watchdog');
        return;
      }
    }
    const st = this.step;
    if (st && st.limitMs && this.mono() - st.since > st.limitMs) {
      this.logFn(`watchdog: ${st.name} did not finish within ${Math.round((this.mono() - st.since) / 1000)}s, forcing a fresh reconnect`);
      this.step = null;
      this.wake('stuck');
    }
  }

  summaryLine(c) {
    const age = Math.round((this.mono() - c.lastFrameAt) / 1000);
    return `heartbeat summary conn_sent=${c.hbSent} conn_acked=${c.hbAcked} outstanding=${c.outstanding} frames=${c.frames} `
      + `last_frame_age=${age}s interval=${c.interval}ms total_sent=${this.stats.hbSent} total_acked=${this.stats.hbAcked} events=${this.stats.dispatches}`;
  }

  async connectOnce(wakeSignal) {
    const link = linkSignals([wakeSignal, this.signal]);
    let token, gw;
    try {
      this.setStep('access token request', this.requestTimeoutMs + this.stepMarginMs);
      token = await this.tokens.get({ signal: link.signal });
      this.setStep('gateway url request', this.requestTimeoutMs + this.stepMarginMs);
      gw = await Q.apiRequest({ method: 'GET', path: '/gateway', token, fetchImpl: this.fetchImpl, base: this.apiBase,
        timeoutMs: this.requestTimeoutMs, signal: link.signal });
    } finally { link.dispose(); }
    if (!gw || typeof gw.url !== 'string' || !/^wss:\/\//.test(gw.url)) throw new Error('gateway url missing or invalid');
    if (wakeSignal && wakeSignal.aborted) throw Object.assign(new Error('interrupted'), { name: 'AbortError' });
    this.setStep('websocket handshake', this.connectTimeoutMs + this.stepMarginMs);
    return new Promise((resolve) => {
      const ws = new this.WebSocketImpl(gw.url);
      const c = {
        done: false, localReason: null, interval: 0, hbTimer: null, hbFirst: null, summaryTimer: null, fallback: null, helloTimer: null,
        hbSent: 0, hbAcked: 0, outstanding: 0, frames: 0, lastFrameAt: this.mono(), firstAckLogged: false, lastHbSentAt: 0,
      };
      this.ws = ws; this.conn = c;
      try { ws.binaryType = 'arraybuffer'; } catch { /* ignore */ }

      const clearTimers = () => {
        if (c.hbTimer) clearInterval(c.hbTimer);
        if (c.hbFirst) clearTimeout(c.hbFirst);
        if (c.summaryTimer) clearTimeout(c.summaryTimer);
        if (c.fallback) clearTimeout(c.fallback);
        if (c.helloTimer) clearTimeout(c.helloTimer);
        c.hbTimer = c.hbFirst = c.summaryTimer = c.fallback = c.helloTimer = null;
      };
      const finish = (code) => {
        if (c.done) return; c.done = true;
        clearTimers();
        if (this.signal) this.signal.removeEventListener('abort', onAbort);
        if (wakeSignal) wakeSignal.removeEventListener('abort', onWakeSignal);
        if (this.ws === ws) this.ws = null;
        if (this.conn === c) this.conn = null;
        if (c.hbSent || c.hbAcked) this.logFn(this.summaryLine(c).replace('heartbeat summary', 'heartbeat summary (closing)'));
        const r = c.localReason;
        // op 9 backs off (at least 3 s, growing until READY/RESUMED), so a session that keeps failing is not retried every 3 s forever
        if (r === 'invalid_session_noresume') { this.clearSession(); this.tokens.invalidate(); resolve({ code, delayMs: Math.max(3000, this.backoff.next()), serverDelay: true }); return; }
        if (r === 'invalid_session_resume') { resolve({ code, delayMs: Math.max(3000, this.backoff.next()), serverDelay: true }); return; }
        if (LOCAL_REASONS_RESUME.has(r)) { resolve({ code, delayMs: 1000 }); return; }
        if (r === 'stop') { resolve({ code, delayMs: 0 }); return; }
        if (r === 'connect_timeout') { resolve({ code, delayMs: null }); return; } // normal backoff
        const a = closeAction(code);
        if (a.fatal) { resolve({ code, fatal: a.fatal }); return; }
        if (a.clearSession) this.clearSession();
        if (a.refreshToken) this.tokens.invalidate();
        resolve({ code, delayMs: a.delayMs ?? null, serverDelay: a.delayMs !== undefined });
      };
      const send = (obj) => {
        if (c.done) return false;
        try { ws.send(JSON.stringify(obj)); return true; } catch (e) { this.logFn(`ws send failed: ${e.message}`); return false; }
      };
      const closeLocal = (why) => {
        if (c.done || c.localReason) return;
        c.localReason = why;
        clearTimers();
        try { ws.close(1000); } catch { /* ignore */ }
        if (ABANDON_REASONS.has(why)) {
          // After a suspend the old socket is almost certainly dead: do not wait for its close handshake.
          this.logFn(`ws closed code=1000 local=${why} (dropped without waiting)`);
          finish(1000); return;
        }
        // A half-open TCP socket may never emit 'close'; do not wait for it forever.
        c.fallback = setTimeout(() => { this.logFn(`ws close not confirmed after ${this.closeFallbackMs}ms (half-open?), abandoning socket`); finish(1000); }, this.closeFallbackMs);
        c.fallback.unref?.();
      };
      c.closeLocal = closeLocal;
      const onAbort = () => closeLocal('stop');
      const onWakeSignal = () => closeLocal(this.wakeReason || 'wake');
      if (this.signal) { if (this.signal.aborted) { queueMicrotask(onAbort); } else this.signal.addEventListener('abort', onAbort, { once: true }); }
      if (wakeSignal) wakeSignal.addEventListener('abort', onWakeSignal, { once: true });
      // A socket that never completes the handshake / never sends HELLO (e.g. SYN lost after a resume) is dropped.
      c.helloTimer = setTimeout(() => {
        c.helloTimer = null;
        if (c.done || c.localReason || c.interval) return;
        this.logFn(`ws: no HELLO within ${Math.round(this.connectTimeoutMs / 1000)}s, dropping the connection`);
        closeLocal('connect_timeout');
      }, this.connectTimeoutMs);
      c.helloTimer.unref?.();

      // Count before writing: an ACK can never be processed before its heartbeat is counted.
      const sendHeartbeat = () => {
        c.hbSent++; this.stats.hbSent++; c.outstanding++; c.lastHbSentAt = this.mono();
        if (!send({ op: OP.HEARTBEAT, d: this.seq })) { c.hbSent--; this.stats.hbSent--; c.outstanding--; }
      };
      const beat = () => {
        if (c.done || c.localReason) return;
        const silentFor = this.mono() - c.lastFrameAt; // monotonic: a wall-clock step cannot fake or hide silence
        if (c.outstanding >= 2) { this.logFn(`heartbeat: ${c.outstanding} consecutive heartbeats not ACKed, reconnecting (resume)`); closeLocal('zombie'); return; }
        if (silentFor > this.staleFactor * c.interval) {
          this.logFn(`heartbeat: no gateway frame for ${Math.round(silentFor / 1000)}s (~2 heartbeat intervals), reconnecting (resume)`);
          closeLocal('stale'); return;
        }
        sendHeartbeat();
      };
      const summary = (delay) => {
        c.summaryTimer = setTimeout(() => { if (c.done) return; this.logFn(this.summaryLine(c)); summary(this.summaryEveryMs); }, delay);
        c.summaryTimer.unref?.();
      };

      ws.addEventListener('open', () => this.logFn('ws open'));
      ws.addEventListener('error', () => { if (!c.done) this.logFn('ws error'); });
      ws.addEventListener('close', (ev) => {
        if (c.done) return; // already handled (e.g. fallback after a half-open close)
        this.logFn(`ws closed code=${ev.code}${ev.reason ? ' reason=' + Q.preview(ev.reason, 60) : ''}${c.localReason ? ' local=' + c.localReason : ''}`);
        finish(ev.code);
      });
      ws.addEventListener('message', (ev) => {
        if (c.done) return; // ignore frames from an abandoned socket
        c.frames++; c.lastFrameAt = this.mono(); this.stats.frames++;
        try { this.onAlive(); } catch { /* ignore */ }
        let p;
        try { p = JSON.parse(decodeData(ev.data)); } catch { this.logFn('ws bad payload'); return; }
        if (typeof p.s === 'number') { this.seq = p.s; this.saveSession(); }
        switch (p.op) {
          case OP.HELLO: {
            c.interval = Number(p.d && p.d.heartbeat_interval) > 0 ? Number(p.d.heartbeat_interval) : 41250;
            if (c.helloTimer) { clearTimeout(c.helloTimer); c.helloTimer = null; }
            if (this.conn === c) this.setStep('connected', 0); // liveness is now watched by heartbeats and the stale watchdog
            this.logFn(`HELLO heartbeat_interval=${c.interval}ms`);
            if (this.sessionId && this.seq !== null) {
              this.logFn('sending RESUME');
              send({ op: OP.RESUME, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.seq } });
            } else {
              this.logFn(`sending IDENTIFY intents=${this.intents}`);
              send({ op: OP.IDENTIFY, d: { token: `QQBot ${token}`, intents: this.intents, shard: [0, 1], properties: { $os: process.platform, $browser: 'grokbot-qqbot-bridge', $device: 'grokbot-qqbot-bridge' } } });
            }
            if (c.done || c.localReason) break; // e.g. op 7/9 arrived while answering HELLO
            if (c.hbTimer) clearInterval(c.hbTimer);
            if (c.hbFirst) clearTimeout(c.hbFirst);
            if (c.summaryTimer) clearTimeout(c.summaryTimer);
            c.outstanding = 0;
            // first heartbeat right after HELLO (small jitter), then every interval
            const jitter = Math.floor(Math.random() * Math.min(this.hbJitterMaxMs, c.interval / 4));
            c.hbFirst = setTimeout(() => {
              c.hbFirst = null;
              beat();
              if (!c.done && !c.localReason) c.hbTimer = setInterval(beat, c.interval);
            }, jitter);
            summary(this.summaryFirstMs);
            break;
          }
          case OP.HEARTBEAT_ACK:
            c.hbAcked++; this.stats.hbAcked++; c.outstanding = 0;
            if (!c.firstAckLogged) { c.firstAckLogged = true; this.logFn(`heartbeat first ACK rtt=${Math.round(this.mono() - c.lastHbSentAt)}ms`); }
            break;
          case OP.HEARTBEAT: // server asks for an immediate heartbeat
            sendHeartbeat();
            break;
          case OP.RECONNECT: this.logFn('op 7: gateway asked to reconnect (will resume)'); closeLocal('reconnect'); break;
          case OP.INVALID_SESSION:
            this.logFn(`op 9: invalid session, resumable=${!!p.d} (${p.d ? 'will resume' : 'will re-identify'})`);
            closeLocal(p.d ? 'invalid_session_resume' : 'invalid_session_noresume');
            break;
          case OP.DISPATCH: this.stats.dispatches++; this.onDispatch(p); break;
          default: this.logFn(`unknown op ${p.op}`); break;
        }
      });
    });
  }

  onDispatch(p) {
    if (p.t === 'READY') {
      this.sessionId = p.d && p.d.session_id; this.backoff.reset(); this.saveSession();
      this.logFn('READY'); this.onState('RUNNING');
    } else if (p.t === 'RESUMED') {
      this.backoff.reset(); this.saveSession(); this.logFn('RESUMED'); this.onState('RUNNING');
    } else if (p.t === 'C2C_MESSAGE_CREATE') {
      Promise.resolve(this.onC2C(p.d)).catch((e) => this.logFn(`c2c handler error: ${e.message}`));
    } else if (p.t) {
      this.logFn(`event ${p.t} (ignored)`);
    }
  }
}

module.exports = { Gateway, closeAction, decodeData, FatalError, OP, abortableSleep, linkSignals };

#!/usr/bin/env node
'use strict';
// QQ Bot (API v2) WebSocket gateway -> webhook forwarder. Outbound HTTPS/WSS only: it never listens on a port.
// Usage: node bin/bridge.js            run in the foreground (start.sh runs it in the background)
//        node bin/bridge.js --check    validate configuration, then exit
// Exit codes: 0 stopped, 1 crash, 2 configuration / already running, 15 BANNED, 16 BAD_CREDENTIALS,
// 17 IP_WHITELIST, 18 INTENT_DENIED.
const fs = require('node:fs');
const C = require('../src/config');
const F = require('../src/files');
const Q = require('../src/qq');
const { createGuard } = require('../src/guard');
const { postWebhook } = require('../src/webhook');
const { Gateway, FatalError } = require('../src/gateway');
const { makeC2CHandler } = require('../src/handler');
const { createSerialQueue } = require('../src/queue');
const { createMediaStore } = require('../src/media-store');
const { fetchMedia } = require('../src/media');

const STOP_GRACE_MS = Number(process.env.BRIDGE_STOP_GRACE_MS) || 10_000;
const QUEUE_MAX = 100;

function main() {
  let cfg;
  try { cfg = C.loadConfig(); } catch (e) {
    if (e instanceof C.ConfigError) { console.error(`ERROR ${e.message}`); process.exit(C.EXIT.CONFIG); }
    throw e;
  }
  if (typeof globalThis.WebSocket !== 'function') { console.error('ERROR this Node.js has no global WebSocket (Node >= 22 required)'); process.exit(C.EXIT.CONFIG); }
  if (process.argv.includes('--check')) {
    console.log(`config OK (owner protection ${cfg.protection ? 'on' : 'off'}, mirror ${cfg.mirror}, media ${cfg.acceptMedia ? 'on' : 'off'})`);
    process.exit(0);
  }
  const P = C.paths(cfg);
  F.ensureDir(cfg.stateDir); F.ensureDir(cfg.logDir);
  const log = F.makeLogger(P.log, { echo: process.env.BRIDGE_LOG_STDERR === '1' });
  const setStatus = (s) => { try { F.writeSecure(P.status, s + '\n'); } catch (e) { log(`cannot write STATUS: ${e.code || e.message}`); } };

  const lock = F.acquirePidLock(P.pid);
  if (!lock.ok) { console.error(`ERROR another bridge is already running from this state folder (pid ${lock.pid})`); process.exit(C.EXIT.CONFIG); }
  const removePid = () => { try { if (F.readText(P.pid) === String(process.pid)) fs.unlinkSync(P.pid); } catch { /* ignore */ } };
  process.on('exit', removePid);
  const crash = (what, e) => {
    log(`crash (${what}): ${e && e.message}`); setStatus('CRASHED'); removePid(); process.exit(C.EXIT.CRASH);
  };
  process.on('uncaughtException', (e) => crash('uncaught exception', e));
  process.on('unhandledRejection', (e) => crash('unhandled rejection', e));

  const ctrl = new AbortController();
  const store = C.fileStore(P);
  const guard = createGuard({ protection: cfg.protection, explicitOwner: cfg.ownerId, ownerStore: C.ownerStore(P),
    allowlist: cfg.allowlist, rateLimitPerMin: cfg.rateLimitPerMin, globalRateLimitPerMin: cfg.globalRateLimitPerMin,
    maxChars: cfg.maxMessageChars, logFn: log, statsStore: C.statsStore(P) });
  const tokens = new Q.TokenManager({ appId: cfg.appId, secret: cfg.appSecret });
  const forward = (payload) => postWebhook(payload, { url: cfg.webhookUrl, auth: cfg.webhookAuth, logFn: log, userAgent: Q.USER_AGENT });
  let mediaFetch = null;
  if (cfg.acceptMedia) {
    const mediaStore = createMediaStore({ dir: cfg.mediaDir, maxBytes: cfg.mediaMaxBytes, retentionDays: cfg.mediaRetentionDays, allowedHosts: cfg.mediaAllowedHosts });
    const sweep = () => { const n = mediaStore.cleanup(); if (n) log(`media cleanup removed ${n} file(s) older than ${cfg.mediaRetentionDays} day(s)`); };
    sweep(); setInterval(sweep, 60 * 60_000).unref();
    mediaFetch = (collected) => fetchMedia(collected, { store: mediaStore });
  }
  const handler = makeC2CHandler({ store, guard, forward, mirror: cfg.mirror, logFn: log, fetchMedia: mediaFetch });
  // One message at a time, in order: bounded memory for media downloads and ordered webhook calls.
  const queue = createSerialQueue({ worker: handler, maxPending: QUEUE_MAX,
    onOverflow: () => { guard.recordOverload(); log(`drop message: processing queue full (${QUEUE_MAX} waiting)`); },
    onError: (e) => log(`c2c handler error: ${e && e.message}`) });

  let lastBeatWrite = 0;
  const beat = () => { const t = Date.now(); if (t - lastBeatWrite > 10_000) { lastBeatWrite = t; try { F.writeSecure(P.heartbeat, `${t}\n`); } catch { /* ignore */ } } };
  const health = F.readJson(P.health, {}) || {};
  const gw = new Gateway({ tokens, onC2C: (d) => { queue.push(d); }, store, signal: ctrl.signal, apiBase: cfg.apiBase, onAlive: beat,
    onState: (s) => setStatus(s),
    onWake: (reason, driftMs) => { health.last_wake_at = new Date().toISOString(); health.last_wake_drift_ms = Math.max(0, Math.round(driftMs || 0)); try { F.writeJson(P.health, health); } catch { /* ignore */ } },
    logFn: (m) => { log(m); if (/^(connect error|ws closed|heartbeat: |watchdog|clock jump)/.test(m) && !/local=stop/.test(m)) { health.last_error = m.slice(0, 160); health.last_error_at = new Date().toISOString(); try { F.writeJson(P.health, health); } catch { /* ignore */ } } } });

  // Graceful stop: stop receiving, give queued and in-flight messages up to STOP_GRACE_MS, then write anything
  // unfinished to undelivered.jsonl (flagged "interrupted") so it can be replayed.
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return; stopping = true;
    log(`received ${sig}, stopping`);
    ctrl.abort(); queue.close();
    const drained = await queue.drain(STOP_GRACE_MS);
    if (!drained) {
      const { waiting } = queue.takeUnfinished();
      const n = handler.salvage(waiting);
      log(`stop: ${n} unfinished message(s) written to undelivered.jsonl (interrupted)`);
    }
    setStatus('STOPPED'); removePid(); process.exit(0);
  };
  process.on('SIGTERM', () => { stop('SIGTERM'); });
  process.on('SIGINT', () => { stop('SIGINT'); });

  log(`bridge started pid=${process.pid} protection=${cfg.protection ? 'on' : 'off'} mirror=${cfg.mirror} media=${cfg.acceptMedia ? 'on' : 'off'} owner=${guard.owner() ? 'bound' : 'not bound'} session=${gw.sessionId ? 'resume' : 'fresh'}`);
  setStatus('STARTING');
  F.writeSecure(P.heartbeat, `${Date.now()}\n`);
  gw.run().then(() => { if (!stopping) process.exit(0); }, (e) => {
    if (e instanceof FatalError) {
      setStatus(e.fatal.status);
      log(`FATAL ${e.message}; not retrying (exit ${e.fatal.exit}). ${C.FATAL_STATUS[e.fatal.status] || ''}`);
      console.error(`${e.fatal.status}: ${C.FATAL_STATUS[e.fatal.status] || e.message}`);
      process.exit(e.fatal.exit);
    }
    crash('gateway', e);
  });
}

main();

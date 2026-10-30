// qqbot-relay: Cloudflare Worker that receives QQ Bot webhook (HTTP callback) events and forwards
// C2C_MESSAGE_CREATE messages to a webhook with the same payload shape as the WebSocket bridge.
import { readConfig, validationResponse, verifyRequest, makeGuard, mapC2C, postWebhook, makeSeenCache } from './qq.js';

const seen = makeSeenCache();
let guardState = null; // { key, guard } rebuilt when the config changes
const MAX_BODY = 1024 * 1024;
const DEDUPE_CACHE_HOST = 'https://qqbot-relay.dedupe.invalid/';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const ACK = () => json({ op: 12, d: 0 }); // HTTP Callback ACK (d: 0 = success; 1 asks the platform to retry)
const log = (m) => console.log(`[qqbot-relay] ${m}`);

async function cacheSeen(id) {
  try {
    if (typeof caches === 'undefined' || !caches.default) return false;
    const key = new Request(DEDUPE_CACHE_HOST + encodeURIComponent(id));
    if (await caches.default.match(key)) return true;
    await caches.default.put(key, new Response('1', { headers: { 'Cache-Control': 'max-age=21600' } }));
  } catch { /* ignore */ }
  return false;
}

function guardFor(cfg, now) {
  const key = JSON.stringify([cfg.protection, cfg.ownerId, [...cfg.allowlist], cfg.rateLimitPerMin, cfg.globalRateLimitPerMin, cfg.maxChars]);
  if (!guardState || guardState.key !== key) guardState = { key, guard: makeGuard(cfg, now) };
  return guardState.guard;
}

export async function handleRequest(request, env, ctx, deps = {}) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const cfg = readConfig(env);
  if (!cfg.secret) return json({ error: 'not configured' }, 503);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too large' }, 413);
  let p;
  try { p = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  if (!p || typeof p !== 'object') return json({ error: 'bad json' }, 400);

  // op 13: callback URL validation (answered without a request signature, like the official SDK).
  if (p.op === 13) {
    if (!p.d || typeof p.d.plain_token !== 'string' || p.d.event_ts === undefined) return json({ error: 'bad validation request' }, 400);
    return json(await validationResponse(cfg.secret, p.d));
  }

  if (!(await verifyRequest(cfg.secret, request.headers, raw))) { log('reject bad signature'); return json({ error: 'bad signature' }, 401); }

  if (p.op === 1) return json({ op: 11, d: Number(p.d) || 0 }); // heartbeat over HTTP (official SDK behaviour)
  if (p.op !== 0) return ACK();
  if (p.t !== 'C2C_MESSAGE_CREATE') { log(`event ${String(p.t || '').slice(0, 40)} (ignored)`); return ACK(); }

  const d = p.d || {};
  const eventId = p.id ? String(p.id) : '';
  const msgId = d.id ? String(d.id) : '';
  const keys = [eventId && `ev:${eventId}`, msgId && `msg:${msgId}`].filter(Boolean);
  if (keys.some((k) => seen.has(k))) { log('skip duplicate (memory)'); return ACK(); }
  keys.forEach((k) => seen.add(k));

  const now = deps.now || Date.now;
  const r = mapC2C(d, cfg, guardFor(cfg, now), now);
  if (r.skip) { log(`skip ${r.skip}`); return ACK(); }
  if (!cfg.webhookUrl) { log('WEBHOOK_URL not configured'); return ACK(); }

  const work = (async () => {
    const check = deps.cacheSeen || cacheSeen;
    if (msgId && (await check(`msg:${msgId}`))) { log('skip duplicate (cache)'); return; }
    log(`forward text len=${r.payload.text.length}${r.payload.truncated ? ' (truncated)' : ''}${r.payload.media ? ` media=${r.payload.media.length}` : ''}`);
    await postWebhook(r.payload, { url: cfg.webhookUrl, auth: cfg.webhookAuth, fetchImpl: deps.fetchImpl || fetch, sleep: deps.sleep, logFn: log });
  })();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work); else await work;
  return ACK();
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx).catch((e) => { log(`error ${e && e.message}`); return json({ op: 12, d: 1 }, 500); });
  },
};

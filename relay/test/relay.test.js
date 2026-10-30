import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { seedFromSecret, keysFromSecret, signHex, validationResponse, verifyRequest, readConfig, makeGuard, mapC2C,
  collectAttachments, eventText, postWebhook, HANDLING_HINT, RELAY_HINT, MEDIA_HINT } from '../src/qq.js';
import { handleRequest } from '../src/index.js';

const require = createRequire(import.meta.url);
const bridgeDir = new URL('../../src/', import.meta.url).pathname;
const hasBridge = existsSync(bridgeDir + 'guard.js');
const SECRET = 'testsecretABCDEFGHIJ';
const OWNER = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4';
let n = 0;

function c2c(extra = {}) {
  n++;
  return { id: `ROBOT1.0_msg${n}`, content: 'hello', timestamp: '2026-01-01T12:00:00+08:00', author: { id: 'x', user_openid: OWNER, union_openid: 'u' }, ...extra };
}
function dispatch(d, t = 'C2C_MESSAGE_CREATE') { n++; return { op: 0, id: `C2C_MESSAGE_CREATE:evt${n}`, d, t }; }
async function signed(body, { secret = SECRET, bad = false } = {}) {
  const raw = JSON.stringify(body); const ts = '1725442341';
  let sig = await signHex(secret, ts + raw);
  if (bad) sig = sig.slice(0, -2) + (sig.endsWith('00') ? '01' : '00');
  return new Request('https://relay.test/', { method: 'POST', body: raw, headers: { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts, 'User-Agent': 'QQBot-Callback' } });
}
const ctxC = () => { const jobs = []; return { ctx: { waitUntil: (p) => jobs.push(p) }, done: () => Promise.all(jobs) }; };

test('doc vector: key derivation from secret', async () => {
  assert.deepEqual([...seedFromSecret('naOC0ocQE3shWLAfffVLB1rhYPG7')], [...new TextEncoder().encode('naOC0ocQE3shWLAfffVLB1rhYPG7naOC')]);
  const { publicRaw } = await keysFromSecret('naOC0ocQE3shWLAfffVLB1rhYPG7');
  assert.deepEqual([...publicRaw], [215, 195, 98, 254, 120, 174, 248, 31, 242, 50, 135, 180, 147, 98, 139, 93, 176, 42, 60, 79, 227, 11, 33, 94, 77, 25, 96, 155, 93, 118, 103, 58]);
});

// The request-signature example on the "Security and authorization" page (secret naOC0..., timestamp 1725442341)
// does not verify with any Ed25519 implementation for the body as printed (the page's key derivation example and
// the callback-validation example on the Webhook page both do match, see the other two doc-vector tests), so the
// request check is tested by round trip with the same key derivation instead.
test('request signature round trip (timestamp + raw body)', async () => {
  const S = 'naOC0ocQE3shWLAfffVLB1rhYPG7';
  const body = '{ "op": 0,"d": {}, "t": "GATEWAY_EVENT_NAME"}';
  const sig = await signHex(S, '1725442341' + body);
  const h = new Headers({ 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': '1725442341' });
  assert.equal(await verifyRequest(S, h, body), true);
  assert.equal(await verifyRequest(S, h, body + ' '), false);
  assert.equal(await verifyRequest(S, new Headers({ 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': '1725442342' }), body), false);
  assert.equal(await verifyRequest(S, new Headers({ 'X-Signature-Ed25519': 'zz', 'X-Signature-Timestamp': '1' }), body), false);
  assert.equal(await verifyRequest(S, new Headers(), body), false);
});

test('doc vector: callback URL validation (op 13)', async () => {
  const r = await validationResponse('DG5g3B4j9X2KOErG', { plain_token: 'Arq0D5A61EgUu4OxUvOp', event_ts: '1725442341' });
  assert.deepEqual(r, { plain_token: 'Arq0D5A61EgUu4OxUvOp',
    signature: '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706' });
  const res = await handleRequest(new Request('https://r/', { method: 'POST', body: '{"d":{"plain_token":"Arq0D5A61EgUu4OxUvOp","event_ts":"1725442341"},"op":13}' }), { QQBOT_APP_SECRET: 'DG5g3B4j9X2KOErG' }, null);
  assert.deepEqual(await res.json(), r);
});

test('signature enforcement and ACK format', async () => {
  const env = { QQBOT_APP_SECRET: SECRET };
  assert.equal((await handleRequest(await signed(dispatch(c2c()), { bad: true }), env, null)).status, 401);
  assert.equal((await handleRequest(await signed(dispatch(c2c()), { secret: 'othersecret123' }), env, null)).status, 401);
  assert.equal((await handleRequest(new Request('https://r/', { method: 'POST', body: JSON.stringify(dispatch(c2c())) }), env, null)).status, 401);
  const ok = await handleRequest(await signed(dispatch({}, 'FRIEND_ADD')), env, null);
  assert.deepEqual(await ok.json(), { op: 12, d: 0 });
  assert.equal((await handleRequest(new Request('https://r/'), env, null)).status, 405);
});

test('payload equals the bridge mapping (text, voice, image, file)', { skip: !hasBridge }, () => {
  const { buildPayload } = require(bridgeDir + 'guard.js');
  const bm = require(bridgeDir + 'media.js');
  const H = require(bridgeDir + 'handler.js');
  const at = Date.parse('2026-01-01T00:00:00Z');
  const events = [
    c2c(),
    c2c({ content: '  spaced  ' }),
    c2c({ content: '', attachments: [{ content_type: 'voice', url: '//x.qq.com/v.silk', voice_wav_url: 'https://x.qq.com/v.wav', asr_refer_text: 'remind me' }] }),
    c2c({ content: 'look', attachments: [{ content_type: 'image/png', url: 'https://x.qq.com/i.png', width: 10, height: 20, size: 99 }, { content_type: 'file', url: 'https://x.qq.com/f', filename: 'a.pdf' }] }),
    c2c({ content: 'x'.repeat(4005) }),
  ];
  for (const protection of ['on', 'off']) {
    const cfg = readConfig({ OWNER_PROTECTION: protection, OWNER_ID: OWNER, MIRROR_TO_MAIN_CHAT: 'false', MAX_MESSAGE_CHARS: '4000' });
    const g = makeGuard(cfg);
    for (const d of events) {
      const mine = mapC2C(d, cfg, g, () => at).payload;
      // Bridge expectation, with the attachment downloads replaced by our metadata entries.
      assert.deepEqual(collectAttachments(d).map((c) => c.kind), bm.collectAttachments(d).map((c) => c.kind));
      const text = eventText(d, collectAttachments(d));
      const bt = [typeof d.content === 'string' ? d.content.trim() : '', ...bm.collectAttachments(d).filter((c) => c.transcript).map((c) => H.VOICE_PREFIX + c.transcript)].filter(Boolean).join('\n').trim();
      assert.equal(text, bt);
      const truncated = text.length > 4000;
      const expected = buildPayload({ source: 'qq', senderId: OWNER, messageId: d.id, text: truncated ? text.slice(0, 4000) : text, truncated,
        untrusted: protection === 'on', mirror: false, receivedAt: new Date(at), media: mine.media });
      const { handling_hint: h1, ...a } = mine; const { handling_hint: h2, ...b } = expected;
      assert.deepEqual(Object.keys(mine), Object.keys(expected));
      assert.deepEqual(a, b);
      if (protection === 'on') assert.ok(h1.startsWith(h2)); else assert.equal(h1, undefined);
    }
  }
});

test('media entries, hints, owner protection, rate limit', () => {
  const cfg = readConfig({ OWNER_PROTECTION: 'on', OWNER_ID: OWNER, RATE_LIMIT_PER_MIN: '2' });
  const g = makeGuard(cfg);
  const p = mapC2C(c2c({ content: '', attachments: [{ content_type: 'image/jpeg', url: '//x.qq.com/a.jpg', width: 3, height: 4 }] }), cfg, g).payload;
  assert.deepEqual(p.media, [{ kind: 'image', path: null, content_type: null, size: null, error: 'NOT_DOWNLOADED', url: 'https://x.qq.com/a.jpg', declared_content_type: 'image/jpeg', width: 3, height: 4 }]);
  assert.equal(p.handling_hint, [HANDLING_HINT, RELAY_HINT, MEDIA_HINT].join(' '));
  assert.equal(mapC2C(c2c(), cfg, g).payload.text, 'hello');
  assert.equal(mapC2C(c2c(), cfg, g).skip, 'rate_limited');
  assert.equal(mapC2C(c2c({ author: { user_openid: 'STRANGER' } }), cfg, g).skip, 'dropped');
  const allow = readConfig({ OWNER_PROTECTION: 'on', OWNER_ID: OWNER, ALLOWLIST: 'FRIEND1, FRIEND2' });
  assert.ok(mapC2C(c2c({ author: { user_openid: 'FRIEND2' } }), allow, makeGuard(allow)).payload);
  assert.equal(mapC2C(c2c({ author: { user_openid: OWNER, bot: true } }), allow, makeGuard(allow)).skip, 'not_user');
  const voiceOnly = mapC2C(c2c({ content: '', attachments: [{ content_type: 'voice', asr_refer_text: 'hi' }] }), allow, makeGuard(allow)).payload;
  assert.equal(voiceOnly.text, '[voice] hi');
  assert.deepEqual(voiceOnly.media, [{ kind: 'voice', transcript: 'hi', path: null, content_type: null, size: null }]);
  const noMedia = readConfig({ ACCEPT_MEDIA: 'false' });
  assert.equal(mapC2C(c2c({ content: '', attachments: [{ content_type: 'image/png', url: 'https://x/a' }] }), noMedia, makeGuard(noMedia)).skip, 'non_text');
});

test('forwards to a mock webhook with auth, dedupes, retries', async () => {
  const got = []; let fail = 1;
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (fail-- > 0) { res.writeHead(502); return res.end(); }
    got.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const env = { QQBOT_APP_SECRET: SECRET, WEBHOOK_URL: `http://127.0.0.1:${srv.address().port}/h`, WEBHOOK_AUTH: 'Bearer test',
    OWNER_PROTECTION: 'on', OWNER_ID: OWNER, MIRROR_TO_MAIN_CHAT: 'false' };
  const deps = { sleep: async () => {}, cacheSeen: async () => false };
  try {
    const ev = dispatch(c2c({ content: 'ping' }));
    let c = ctxC();
    const res = await handleRequest(await signed(ev), env, c.ctx, deps);
    assert.deepEqual(await res.json(), { op: 12, d: 0 });
    await c.done();
    assert.equal(got.length, 1); assert.equal(got[0].auth, 'Bearer test');
    assert.equal(got[0].body.source, 'qq'); assert.equal(got[0].body.text, 'ping'); assert.equal(got[0].body.untrusted, true);
    c = ctxC(); await handleRequest(await signed(ev), env, c.ctx, deps); await c.done();
    c = ctxC(); await handleRequest(await signed({ ...ev, id: 'other-event-id' }), env, c.ctx, deps); await c.done(); // same message, new event id
    c = ctxC(); await handleRequest(await signed(dispatch(c2c({ author: { user_openid: 'STRANGER' } }))), env, c.ctx, deps); await c.done();
    assert.equal(got.length, 1);
  } finally { srv.close(); }
});

test('postWebhook retry policy', async () => {
  let calls = 0;
  assert.equal(await postWebhook({}, { url: 'http://x', fetchImpl: async () => { calls++; return new Response('', { status: 403 }); }, sleep: async () => {} }), false);
  assert.equal(calls, 1); calls = 0;
  await postWebhook({}, { url: 'http://x', fetchImpl: async () => { calls++; return new Response('', { status: 503 }); }, sleep: async () => {} });
  assert.equal(calls, 3);
});

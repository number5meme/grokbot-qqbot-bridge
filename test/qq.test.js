'use strict';
// QQ-specific tests: tokens, C2C handling with sender protection, gateway (heartbeat, resume, stale detection,
// clock jumps, backoff), text/image replies, and CLI behavior. No network: fetch and WebSocket are faked.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync, spawn } = require('node:child_process');
const Q = require('../src/qq');
const { Gateway, closeAction, FatalError } = require('../src/gateway');
const { makeC2CHandler } = require('../src/handler');
const { sendReply, sendImage, loadImage, sniffImage, MAX_IMAGE_BYTES } = require('../src/reply');
const { createGuard, HANDLING_HINT } = require('../src/guard');
const { Backoff } = require('../src/backoff');
const { makeFetch, FakeWS, memStore, memOwner } = require('./fakes');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-qqbot-test-'));
const ROOT = path.join(__dirname, '..');
const OWNER = 'ABCDEF1234567890ABCDEF1234567890';
const STRANGER = 'ZZZZZZ9999999999ZZZZZZ9999999999';
const noSleep = async () => {};
const zeroBackoff = () => new Backoff({ baseMs: 1000, maxMs: 60_000, random: () => 0 });
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

test('stripUrls', () => {
  assert.strictEqual(Q.stripUrls('see https://a.com/x?y=1 and www.b.cn/z and c.example.org end'), 'see [link removed] and [link removed] and [link removed] end');
  assert.strictEqual(Q.stripUrls('no link 1.5 times'), 'no link 1.5 times');
});

test('TokenManager: string expires_in, caching, early refresh, error mapping', async () => {
  let t = 1_000_000; let n = 0;
  const f = makeFetch((call) => {
    assert.strictEqual(call.url, Q.TOKEN_URL);
    assert.deepStrictEqual(call.body, { appId: 'APP', clientSecret: 'SEC' });
    n++; return { body: { access_token: `tok${n}`, expires_in: '7200' } };
  });
  const tm = new Q.TokenManager({ appId: 'APP', secret: 'SEC', fetchImpl: f, now: () => t });
  assert.strictEqual(await tm.get(), 'tok1');
  t += 60 * 60_000; assert.strictEqual(await tm.get(), 'tok1'); // 1 h later: cached
  t += 56 * 60_000; assert.strictEqual(await tm.get(), 'tok2'); // 4 min left: refreshed early
  assert.strictEqual(await tm.get({ force: true }), 'tok3');
  tm.invalidate(); await Promise.all([tm.get(), tm.get(), tm.get()]); assert.strictEqual(n, 4); // single-flight

  const bad = new Q.TokenManager({ appId: 'A', secret: 'B', fetchImpl: makeFetch(() => ({ status: 200, body: { code: 100016, message: 'invalid appid or secret' } })) });
  await assert.rejects(bad.get(), (e) => e instanceof Q.QQError && Q.fatalOf(e) === Q.FATAL.BAD_CREDENTIALS && !String(e.message).includes('B'));
  const ip = new Q.TokenManager({ appId: 'A', secret: 'B', fetchImpl: makeFetch(() => ({ status: 200, body: { code: 11298, message: 'source IP not in whitelist' } })) });
  await assert.rejects(ip.get(), (e) => Q.fatalOf(e) === Q.FATAL.IP_WHITELIST);
  const net = new Q.TokenManager({ appId: 'A', secret: 'B', fetchImpl: makeFetch(() => ({ throw: 'TypeError' })) });
  await assert.rejects(net.get(), (e) => e instanceof Q.QQError && Q.fatalOf(e) === null && e.label === 'NETWORK');
  assert.throws(() => new Q.TokenManager({ appId: '', secret: 'x' }));
});

/* ---------------- C2C handling + sender protection ---------------- */
function c2c({ protection = true, owner = null, rate = 20, allowlist = [], mirror = true, forwardOk = true, now = () => 5000 } = {}) {
  const store = memStore(); const ownerStore = memOwner(owner); const logs = []; const fwd = [];
  const guard = createGuard({ protection, ownerStore, allowlist, rateLimitPerMin: rate, maxChars: 100, logFn: (m) => logs.push(m) });
  const h = makeC2CHandler({ store, guard, mirror, forward: async (p) => { fwd.push(p); return forwardOk; }, logFn: (m) => logs.push(m), now });
  return { store, ownerStore, guard, logs, fwd, h };
}
const ev = (id, openid, content, extra = {}) => ({ id, author: { user_openid: openid }, content, ...extra });

test('C2C protection on: first sender binds, others dropped silently and counted, payload untrusted with hint', async () => {
  const t = c2c();
  assert.strictEqual(await t.h(ev('m1', OWNER, ' hello ')), 'forwarded');
  assert.strictEqual(t.ownerStore.peek(), OWNER);
  assert.deepStrictEqual(t.fwd[0], { source: 'qq', sender_id: OWNER, message_id: 'm1', text: 'hello', truncated: false,
    received_at: new Date(5000).toISOString(), untrusted: true, mirror: true, handling_hint: HANDLING_HINT });
  assert.strictEqual(await t.h(ev('m1', OWNER, 'hello')), 'duplicate');
  assert.strictEqual(await t.h(ev('s1', STRANGER, 'spam')), 'dropped');
  assert.strictEqual(await t.h(ev('s2', STRANGER, 'spam')), 'dropped');
  assert.strictEqual(t.guard.stats.dropped_not_owner, 2);
  assert.strictEqual(t.ownerStore.peek(), OWNER);
  assert.strictEqual(t.store.getLastMsg(STRANGER), null, 'no reply bookkeeping for dropped senders');
  assert.strictEqual(t.store.getLastSender(), OWNER);
  const all = t.logs.join('\n');
  assert.ok(!all.includes(OWNER) && !all.includes(STRANGER) && !all.includes('spam') && !all.includes('hello'));
  assert.ok(t.logs.some((l) => l.startsWith('OWNER_BOUND') && l.includes('ABCDEF...')));
});

test('C2C protection on: rate limit and allowlist', async () => {
  const t = c2c({ owner: OWNER, rate: 2, allowlist: [STRANGER] });
  const r = [];
  for (let i = 0; i < 3; i++) r.push(await t.h(ev('o' + i, OWNER, 'x')));
  assert.deepStrictEqual(r, ['forwarded', 'forwarded', 'rate_limited']);
  assert.strictEqual(await t.h(ev('f1', STRANGER, 'y')), 'forwarded');
  assert.strictEqual(t.guard.stats.dropped_rate_limited, 1);
});

test('C2C protection off: no binding, every sender forwarded with untrusted false, mirror passes through', async () => {
  const t = c2c({ protection: false, mirror: false, rate: 1 });
  assert.strictEqual(await t.h(ev('a', OWNER, 'one')), 'forwarded');
  assert.strictEqual(await t.h(ev('b', STRANGER, 'two')), 'forwarded');
  assert.strictEqual(await t.h(ev('c', STRANGER, 'three')), 'forwarded');
  assert.strictEqual(t.ownerStore.peek(), null);
  assert.ok(t.fwd.every((p) => p.untrusted === false && p.mirror === false && !('handling_hint' in p) && !('sender_binding' in p)));
  assert.deepStrictEqual(t.fwd.map((p) => p.sender_id), [OWNER, STRANGER, STRANGER]);
  assert.strictEqual(t.store.getLastSender(), STRANGER);
});

test('C2C: non-text saves reply window, long text truncated, undelivered kept, invalid events', async () => {
  let now = 9000;
  const t = c2c({ owner: OWNER, now: () => now });
  assert.strictEqual(await t.h(ev('m2', OWNER, '', { attachments: [{}] })), 'non_text');
  assert.deepStrictEqual(t.store.getLastMsg(OWNER), { msg_id: 'm2', received_ms: 9000 });
  now = 10_000;
  assert.strictEqual(await t.h(ev('m3', OWNER, 'z'.repeat(150))), 'forwarded');
  assert.strictEqual(t.fwd[0].text.length, 100); assert.strictEqual(t.fwd[0].truncated, true);
  const u = c2c({ owner: OWNER, forwardOk: false });
  assert.strictEqual(await u.h(ev('m4', OWNER, 'lost')), 'undelivered');
  assert.strictEqual(u.store.s.undelivered[0].text, 'lost');
  assert.strictEqual(await u.h({ author: { user_openid: OWNER } }), 'invalid');
});

test('C2C: dedupe survives restart; seen list capped at 500', async () => {
  const t = c2c({ owner: OWNER });
  await t.h(ev('m1', OWNER, 'a'));
  const h2 = makeC2CHandler({ store: t.store, guard: t.guard, forward: async () => true });
  assert.strictEqual(await h2(ev('m1', OWNER, 'a')), 'duplicate');
  const big = c2c({ owner: OWNER, rate: 0 });
  for (let i = 0; i < 520; i++) await big.h(ev('x' + i, OWNER, 'a'));
  assert.strictEqual(big.store.s.seen.length, 500); assert.strictEqual(big.store.s.seen[0], 'x20');
});

/* ---------------- gateway ---------------- */
test('closeAction mapping', () => {
  assert.strictEqual(closeAction(4914).fatal, Q.FATAL.BANNED);
  assert.strictEqual(closeAction(4915).fatal, Q.FATAL.BANNED);
  assert.strictEqual(closeAction(4014).fatal, Q.FATAL.INTENT_DENIED);
  assert.deepStrictEqual(closeAction(4004), { clearSession: false, refreshToken: true });
  assert.strictEqual(closeAction(4008).delayMs, 60000);
  assert.strictEqual(closeAction(4006).clearSession, true);
  assert.strictEqual(closeAction(4009).clearSession, false);
  assert.strictEqual(closeAction(4905).clearSession, true);
  assert.deepStrictEqual(closeAction(1006), { clearSession: false, refreshToken: false });
});

function gwFetch(extra) {
  return makeFetch((c) => {
    if (c.url === Q.TOKEN_URL) return { body: { access_token: 'TOK', expires_in: '7200' } };
    if (c.url.endsWith('/gateway')) { assert.strictEqual(c.headers.Authorization, 'QQBot TOK'); return extra ? extra(c) : { body: { url: 'wss://fake/websocket' } }; }
    return { status: 404 };
  });
}

test('Gateway: identify(1<<25) -> READY -> C2C dispatch -> heartbeat -> 4009 -> RESUME -> 4914 fatal', async () => {
  FakeWS.instances = [];
  const store = memStore(); const got = []; const logs = [];
  const tokens = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: gwFetch() });
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    ws.onSend = (m) => {
      if (m.op === 1) ws.push({ op: 11 });
      if (idx === 0 && m.op === 2) {
        ws.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess-1', user: {} } });
        ws.push({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', id: 'ev', d: { id: 'm1', author: { user_openid: OWNER }, content: 'hi' } });
        setTimeout(() => ws.serverClose(4009), 60); // after a few heartbeats
      }
      if (idx === 1 && m.op === 6) { ws.push({ op: 0, s: 3, t: 'RESUMED', d: '' }); setTimeout(() => ws.serverClose(4914), 5); }
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 15 } });
  };
  const gw = new Gateway({ tokens, onC2C: async (d) => got.push(d), store, fetchImpl: tokens.fetchImpl, WebSocketImpl: FakeWS, logFn: (m) => logs.push(m), sleep: noSleep, backoff: zeroBackoff(), clock: null });
  await assert.rejects(gw.run(), (e) => e instanceof FatalError && e.fatal === Q.FATAL.BANNED);
  const [ws0, ws1] = FakeWS.instances;
  const ident = ws0.sent.find((m) => m.op === 2);
  assert.strictEqual(ident.d.intents, 33554432);
  assert.strictEqual(ident.d.token, 'QQBot TOK');
  assert.deepStrictEqual(ident.d.shard, [0, 1]);
  assert.ok(ws0.sent.some((m) => m.op === 1 && m.d === 2), 'heartbeat carries last seq');
  assert.strictEqual(got.length, 1); assert.strictEqual(got[0].id, 'm1');
  const resume = ws1.sent.find((m) => m.op === 6);
  assert.deepStrictEqual(resume.d, { token: 'QQBot TOK', session_id: 'sess-1', seq: 2 });
  assert.ok(!ws1.sent.some((m) => m.op === 2), 'no identify when resuming');
  assert.deepStrictEqual(store.s.session, { session_id: 'sess-1', seq: 3 });
  assert.ok(!logs.join('\n').includes('TOK'));
  FakeWS.onCreate = null;
});

test('Gateway: op 9 (not resumable) clears session then identifies; zombie heartbeat reconnects', async () => {
  FakeWS.instances = [];
  const store = memStore({ session: { session_id: 'old', seq: 99 } });
  const tokens = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: gwFetch() });
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    ws.onSend = (m) => {
      if (idx === 0 && m.op === 6) ws.push({ op: 9, d: false });
      if (idx === 1 && m.op === 2) ws.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'new' } }); // never acks heartbeats -> zombie
      if (idx === 2) setImmediate(() => ws.serverClose(4915));
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 10 } });
  };
  const gw = new Gateway({ tokens, onC2C: async () => {}, store, fetchImpl: tokens.fetchImpl, WebSocketImpl: FakeWS, logFn: () => {}, sleep: noSleep, backoff: zeroBackoff(), clock: null });
  await assert.rejects(gw.run(), (e) => e.fatal === Q.FATAL.BANNED);
  assert.ok(FakeWS.instances[0].sent.some((m) => m.op === 6 && m.d.session_id === 'old'));
  assert.ok(FakeWS.instances[1].sent.some((m) => m.op === 2));
  assert.ok(FakeWS.instances.length >= 3, 'zombie connection replaced');
  assert.ok(FakeWS.instances[2].sent.some((m) => m.op === 6 && m.d.session_id === 'new'));
  FakeWS.onCreate = null;
});

test('Gateway: 11298 on /gateway -> IP_WHITELIST fatal; 100016 -> BAD_CREDENTIALS; network -> backoff', async () => {
  const tokens = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: gwFetch(() => ({ status: 401, body: { code: 11298, message: 'source IP not in whitelist' } })) });
  const gw = new Gateway({ tokens, onC2C: async () => {}, store: memStore(), fetchImpl: tokens.fetchImpl, WebSocketImpl: FakeWS, logFn: () => {}, sleep: noSleep, backoff: zeroBackoff(), clock: null });
  await assert.rejects(gw.run(), (e) => e.fatal === Q.FATAL.IP_WHITELIST);

  const t2 = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: makeFetch(() => ({ body: { code: 100016, message: 'invalid appid or secret' } })) });
  const gw2 = new Gateway({ tokens: t2, onC2C: async () => {}, store: memStore(), fetchImpl: t2.fetchImpl, WebSocketImpl: FakeWS, logFn: () => {}, sleep: noSleep, backoff: zeroBackoff(), clock: null });
  await assert.rejects(gw2.run(), (e) => e.fatal === Q.FATAL.BAD_CREDENTIALS);

  let n = 0; const delays = []; const ctrl = new AbortController();
  const t3 = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: makeFetch(() => { n++; return { throw: 'TypeError' }; }) });
  const gw3 = new Gateway({ tokens: t3, onC2C: async () => {}, store: memStore(), fetchImpl: t3.fetchImpl, WebSocketImpl: FakeWS, logFn: () => {}, signal: ctrl.signal,
    sleep: async (ms) => { delays.push(ms); if (delays.length >= 7) ctrl.abort(); }, backoff: zeroBackoff(), clock: null });
  await gw3.run();
  assert.deepStrictEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000]);
});

/* ---------------- reply logic ---------------- */
function replyHarness({ lastMs, seq = {}, respond }) {
  const store = memStore({ owner: OWNER, seq });
  if (lastMs !== undefined) store.s.lastMsgs[OWNER] = { msg_id: 'M1', received_ms: lastMs };
  const sends = []; let tokN = 0;
  const f = makeFetch((c) => {
    if (c.url === Q.TOKEN_URL) { tokN++; return { body: { access_token: 'T' + tokN, expires_in: '7200' } }; }
    assert.ok(c.url.endsWith(`/v2/users/${OWNER}/messages`));
    sends.push({ ...c.body, auth: c.headers.Authorization });
    return respond ? respond(c.body, sends.length) : { body: { id: 'R' + sends.length } };
  });
  const tokens = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: f });
  return { store, sends, tokens, f, run: (text, now = 10_000) => sendReply(text, { to: OWNER, tokens, store, fetchImpl: f, now: () => now, logFn: () => {} }) };
}

test('reply: passive within window with incrementing msg_seq, max 4 then active', async () => {
  const h = replyHarness({ lastMs: 0 });
  for (let i = 0; i < 5; i++) await h.run('**message ' + i + '**', 60_000);
  assert.deepStrictEqual(h.sends.slice(0, 4).map((s) => [s.msg_id, s.msg_seq]), [['M1', 1], ['M1', 2], ['M1', 3], ['M1', 4]]);
  assert.strictEqual(h.sends[4].msg_id, undefined); assert.strictEqual(h.sends[4].msg_seq, undefined);
  assert.ok(h.sends.every((s) => s.msg_type === 0 && !/\*/.test(s.content)));
  assert.strictEqual(h.sends[0].auth, 'QQBot T1');
  assert.deepStrictEqual(h.store.s.seq.M1, { seq: 4, count: 4, dead: false });
});

test('reply: window passed -> active; no last msg -> active', async () => {
  const h = replyHarness({ lastMs: 0 });
  const r = await h.run('hi', 61 * 60_000);
  assert.deepStrictEqual([r.passive, r.active], [0, 1]); assert.strictEqual(h.sends[0].msg_id, undefined);
  const h2 = replyHarness({});
  await h2.run('hi'); assert.strictEqual(h2.sends[0].msg_id, undefined);
});

for (const code of [304103, 40034005, 40034128]) {
  test(`reply: passive error ${code} -> falls back to active and marks msg dead`, async () => {
    const h = replyHarness({ lastMs: 0, respond: (b) => (b.msg_id ? { status: 400, body: { code, message: 'expired' } } : { body: { id: 'ok' } }) });
    const r = await h.run('hi');
    assert.deepStrictEqual([r.passive, r.active], [0, 1]);
    assert.strictEqual(h.sends.length, 2); assert.strictEqual(h.sends[0].msg_id, 'M1'); assert.strictEqual(h.sends[1].msg_id, undefined);
    assert.strictEqual(h.store.s.seq.M1.dead, true);
    await h.run('again'); assert.strictEqual(h.sends[2].msg_id, undefined);
  });
}
test('reply: err_code-only body (40034005 as err_code) also triggers fallback', async () => {
  const h = replyHarness({ lastMs: 0, respond: (b) => (b.msg_id ? { status: 400, body: { err_code: 40034005, message: 'x' } } : { body: { id: 'ok' } }) });
  assert.strictEqual((await h.run('hi')).active, 1);
});

test('reply: 304003 strips URLs and retries once; second 304003 errors', async () => {
  const h = replyHarness({ lastMs: 0, respond: (b) => (/https?:/.test(b.content) ? { status: 400, body: { code: 304003 } } : { body: { id: 'ok' } }) });
  await h.run('see [here](https://x.com/a) now');
  assert.strictEqual(h.sends.length, 2); assert.strictEqual(h.sends[1].content, 'see here [link removed] now');
  assert.strictEqual(h.sends[1].msg_seq, 2); // new seq for the retry
  const h2 = replyHarness({ lastMs: 0, respond: () => ({ status: 400, body: { code: 304003 } }) });
  await assert.rejects(h2.run('plain'), (e) => e.label === '304003');
  assert.strictEqual(h2.sends.length, 2);
});

test('reply: 401/11243 refreshes token once and retries; repeated auth error fails', async () => {
  const h = replyHarness({ respond: (_b, n) => (n === 1 ? { status: 401, body: { code: 11243, message: 'token' } } : { body: { id: 'ok' } }) });
  await h.run('hi');
  assert.deepStrictEqual(h.sends.map((s) => s.auth), ['QQBot T1', 'QQBot T2']);
  const h2 = replyHarness({ respond: () => ({ status: 401, body: { code: 11241 } }) });
  await assert.rejects(h2.run('hi'), (e) => e.label === '11241'); assert.strictEqual(h2.sends.length, 2);
});

test('reply: other errors surface; NO_OWNER; long text chunks', async () => {
  const h = replyHarness({ respond: () => ({ status: 400, body: { code: 40054013, message: 'user rejected' } }) });
  await assert.rejects(h.run('hi'), (e) => e.label === '40054013' && e.sentParts === 0);
  const st = memStore();
  await assert.rejects(sendReply('x', { tokens: {}, store: st, to: '' }), (e) => e.label === 'NO_RECIPIENT');
  const h3 = replyHarness({ lastMs: 0 });
  const r = await h3.run('A sentence. '.repeat(375)); // 4500 chars -> 3 chunks
  assert.strictEqual(r.parts, 3); assert.strictEqual(r.passive, 3);
  assert.ok(h3.sends.every((s) => s.content.length <= 1800));
});

/* ---------------- image send ---------------- */
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
function imgFile(name, buf) { const p = path.join(TMP, name); fs.writeFileSync(p, buf); return p; }
function imageHarness({ lastMs, seq = {}, upload, respond }) {
  const store = memStore({ owner: OWNER, seq });
  if (lastMs !== undefined) store.s.lastMsgs[OWNER] = { msg_id: 'M1', received_ms: lastMs };
  const uploads = []; const sends = []; let tokN = 0;
  const f = makeFetch((c) => {
    if (c.url === Q.TOKEN_URL) { tokN++; return { body: { access_token: 'T' + tokN, expires_in: '7200' } }; }
    if (c.url.endsWith(`/v2/users/${OWNER}/files`)) { uploads.push({ ...c.body, auth: c.headers.Authorization }); return upload ? upload(c.body, uploads.length) : { body: { file_uuid: 'U', file_info: 'FINFO', ttl: 3600 } }; }
    assert.ok(c.url.endsWith(`/v2/users/${OWNER}/messages`));
    sends.push({ ...c.body, auth: c.headers.Authorization });
    return respond ? respond(c.body, sends.length) : { body: { id: 'R' + sends.length } };
  });
  const tokens = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: f });
  const logs = [];
  return { store, uploads, sends, logs, run: (file, cap, now = 10_000, extra = {}) => sendImage(file, cap, { to: OWNER, tokens, store, fetchImpl: f, now: () => now, logFn: (m) => logs.push(m), ...extra }) };
}

test('image: sniff png/jpg/gif; loadImage rejects missing, empty, unsupported, too large', () => {
  assert.strictEqual(sniffImage(PNG_BYTES), 'png');
  assert.strictEqual(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
  assert.strictEqual(sniffImage(Buffer.from('GIF89a....')), 'gif');
  assert.strictEqual(sniffImage(Buffer.from('hello world')), null);
  assert.throws(() => loadImage(path.join(TMP, 'nope.png')), (e) => e.label === 'FILE_NOT_FOUND');
  assert.throws(() => loadImage(TMP), (e) => e.label === 'NOT_A_FILE');
  assert.throws(() => loadImage(imgFile('empty.png', Buffer.alloc(0))), (e) => e.label === 'EMPTY_FILE');
  assert.throws(() => loadImage(imgFile('fake.png', Buffer.from('not an image'))), (e) => e.label === 'UNSUPPORTED_TYPE');
  assert.throws(() => loadImage(imgFile('small.png', PNG_BYTES), { maxBytes: 10 }), (e) => e.label === 'FILE_TOO_LARGE');
  assert.strictEqual(MAX_IMAGE_BYTES, 10 * 1024 * 1024);
  const big = path.join(TMP, 'big.png'); fs.writeFileSync(big, PNG_BYTES); fs.truncateSync(big, MAX_IMAGE_BYTES + 1);
  assert.throws(() => loadImage(big), (e) => e.label === 'FILE_TOO_LARGE');
});

test('image: upload base64 file_data then passive msg_type 7 with file_info + caption; shares seq with text', async () => {
  const file = imgFile('ok.png', PNG_BYTES);
  const h = imageHarness({ lastMs: 0, seq: { M1: { seq: 2, count: 2, dead: false } } });
  const r = await h.run(file, '**Image** caption test');
  assert.deepStrictEqual(h.uploads, [{ file_type: 1, srv_send_msg: false, file_data: PNG_BYTES.toString('base64'), auth: 'QQBot T1' }]);
  assert.deepStrictEqual(h.sends, [{ msg_type: 7, media: { file_info: 'FINFO' }, content: 'Image caption test', msg_id: 'M1', msg_seq: 3, auth: 'QQBot T1' }]);
  assert.deepStrictEqual([r.passive, r.active, r.kind], [1, 0, 'png']);
  assert.deepStrictEqual(h.store.s.seq.M1, { seq: 3, count: 3, dead: false });
  assert.ok(h.logs.every((l) => !l.includes(PNG_BYTES.toString('base64')))); // file_data never logged
});

test('image: no caption -> content " "; no last msg / window passed -> active', async () => {
  const file = imgFile('ok2.png', PNG_BYTES);
  const h = imageHarness({});
  await h.run(file, '');
  assert.deepStrictEqual(h.sends[0], { msg_type: 7, media: { file_info: 'FINFO' }, content: ' ', auth: 'QQBot T1' });
  const h2 = imageHarness({ lastMs: 0 });
  const r = await h2.run(file, 'x', 61 * 60_000); assert.strictEqual(r.active, 1); assert.strictEqual(h2.sends[0].msg_id, undefined);
});

test('image: passive expired (40034128) -> active fallback; 4 passive used -> active', async () => {
  const file = imgFile('ok3.png', PNG_BYTES);
  const h = imageHarness({ lastMs: 0, respond: (b) => (b.msg_id ? { status: 400, body: { code: 40034128 } } : { body: { id: 'ok' } }) });
  const r = await h.run(file, 'c');
  assert.deepStrictEqual([r.passive, r.active], [0, 1]);
  assert.deepStrictEqual(h.sends.map((s) => s.msg_id), ['M1', undefined]);
  assert.strictEqual(h.uploads.length, 1); // upload not repeated
  assert.strictEqual(h.store.s.seq.M1.dead, true);
  const h2 = imageHarness({ lastMs: 0, seq: { M1: { seq: 4, count: 4, dead: false } } });
  await h2.run(file, 'c'); assert.strictEqual(h2.sends[0].msg_id, undefined);
});

test('image: upload errors - auth refresh once; other code surfaces with stage; missing file_info; fatal', async () => {
  const file = imgFile('ok4.png', PNG_BYTES);
  const h = imageHarness({ upload: (_b, n) => (n === 1 ? { status: 401, body: { code: 11243 } } : { body: { file_info: 'FI2' } }) });
  await h.run(file, 'c');
  assert.deepStrictEqual(h.uploads.map((u) => u.auth), ['QQBot T1', 'QQBot T2']); assert.strictEqual(h.sends[0].media.file_info, 'FI2');
  const h2 = imageHarness({ upload: () => ({ status: 400, body: { code: 850012, message: 'upload failed' } }) });
  await assert.rejects(h2.run(file, 'c'), (e) => e.label === '850012' && e.stage === 'upload'); assert.strictEqual(h2.sends.length, 0);
  const h3 = imageHarness({ upload: () => ({ body: { file_uuid: 'x' } }) });
  await assert.rejects(h3.run(file, 'c'), (e) => e.label === 'UPLOAD_NO_FILE_INFO');
  const h4 = imageHarness({ upload: () => ({ status: 200, body: { code: 11298, message: 'ip' } }) });
  await assert.rejects(h4.run(file, 'c'), (e) => Q.fatalOf(e) === Q.FATAL.IP_WHITELIST);
  const h5 = imageHarness({ respond: () => ({ status: 400, body: { code: 40054013 } }) });
  await assert.rejects(h5.run(file, 'c'), (e) => e.label === '40054013' && e.stage === 'send');
  await assert.rejects(sendImage(file, 'c', { tokens: {}, store: memStore(), to: '' }), (e) => e.label === 'NO_RECIPIENT');
  const h6 = imageHarness({});
  await assert.rejects(h6.run(path.join(TMP, 'missing.png'), 'c'), (e) => e.label === 'FILE_NOT_FOUND'); assert.strictEqual(h6.uploads.length, 0);
});

/* ---------------- heartbeat / watchdog / op 7 / op 9 paths ---------------- */
function liveGw(store, opts = {}) {
  const logs = []; const delays = [];
  const tokens = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: gwFetch() });
  const gw = new Gateway({ tokens, onC2C: async () => {}, store, fetchImpl: tokens.fetchImpl, WebSocketImpl: FakeWS,
    logFn: (m) => logs.push(m), sleep: async (ms) => { delays.push(ms); }, hbJitterMaxMs: 5, backoff: zeroBackoff(), clock: null, ...opts });
  return { gw, logs, delays };
}
const sinceStart = () => { const t0 = Date.now(); return () => Date.now() - t0; };

test('heartbeat: first beat right after HELLO, ACKs tracked, summary line, first-ACK log', async () => {
  FakeWS.instances = [];
  const store = memStore(); const el = sinceStart(); let firstHbAt = null;
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    ws.onSend = (m) => {
      if (m.op === 2) ws.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'S1' } });
      if (m.op === 1) { if (firstHbAt === null) firstHbAt = el(); ws.push({ op: 11 }); }
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 1000 } }); // 1s interval
    if (idx === 0) setTimeout(() => ws.serverClose(4915), 250);
  };
  const { gw, logs } = liveGw(store, { summaryFirstMs: 120 });
  await assert.rejects(gw.run(), (e) => e.fatal === Q.FATAL.BANNED);
  assert.ok(firstHbAt !== null && firstHbAt < 150, `first heartbeat at ${firstHbAt}ms should be ~immediate, not after the 1000ms interval`);
  assert.ok(logs.some((l) => /^HELLO heartbeat_interval=1000ms$/.test(l)));
  assert.ok(logs.some((l) => /^heartbeat first ACK rtt=\d+ms$/.test(l)));
  const sum = logs.find((l) => l.startsWith('heartbeat summary conn_sent='));
  assert.match(sum, /conn_sent=1 conn_acked=1 outstanding=0 frames=\d+ last_frame_age=\ds interval=1000ms total_sent=1 total_acked=1/);
  assert.strictEqual(gw.stats.hbAcked, 1);
  FakeWS.onCreate = null;
});

test('heartbeat: 2 consecutive un-ACKed beats -> close and RESUME (not identify)', async () => {
  FakeWS.instances = [];
  const store = memStore();
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    ws.onSend = (m) => {
      if (idx === 0 && m.op === 2) ws.push({ op: 0, s: 5, t: 'READY', d: { session_id: 'S1' } }); // no ACKs ever
      if (idx === 1 && m.op === 6) setImmediate(() => ws.serverClose(4914));
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 20 } });
  };
  const { gw, logs, delays } = liveGw(store);
  await assert.rejects(gw.run(), (e) => e.fatal === Q.FATAL.BANNED);
  const ws0 = FakeWS.instances[0];
  assert.strictEqual(ws0.sent.filter((m) => m.op === 1).length, 2, 'exactly 2 beats sent before giving up');
  assert.ok(logs.some((l) => l.includes('2 consecutive heartbeats not ACKed')));
  assert.ok(logs.some((l) => l.includes('local=zombie')));
  assert.deepStrictEqual(FakeWS.instances[1].sent.find((m) => m.op === 6).d, { token: 'QQBot TOK', session_id: 'S1', seq: 5 });
  assert.strictEqual(delays[0], 1000);
  FakeWS.onCreate = null;
});

test('heartbeat: no frame for ~2 intervals (sends failing) -> close and RESUME', async () => {
  FakeWS.instances = [];
  const store = memStore();
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    if (idx === 0) ws.sendThrows = (m) => m.op === 1; // heartbeats can't be written
    ws.onSend = (m) => {
      if (idx === 0 && m.op === 2) ws.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'S1' } });
      if (idx === 1 && m.op === 6) setImmediate(() => ws.serverClose(4914));
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 15 } });
  };
  const { gw, logs } = liveGw(store);
  await assert.rejects(gw.run(), (e) => e.fatal === Q.FATAL.BANNED);
  assert.ok(logs.some((l) => /no gateway frame for \d+s \(~2 heartbeat intervals\)/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => l.includes('local=stale')));
  assert.ok(FakeWS.instances[1].sent.some((m) => m.op === 6));
  FakeWS.onCreate = null;
});

test('half-open socket: close never confirmed -> abandoned after fallback, then RESUME', async () => {
  FakeWS.instances = [];
  const store = memStore();
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    if (idx === 0) ws.halfOpen = true;
    ws.onSend = (m) => {
      if (idx === 0 && m.op === 2) { ws.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'S1' } }); ws.push({ op: 7 }); }
      if (idx === 1 && m.op === 6) setImmediate(() => ws.serverClose(4914));
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 10000 } });
  };
  const { gw, logs } = liveGw(store, { closeFallbackMs: 30 });
  await assert.rejects(gw.run(), (e) => e.fatal === Q.FATAL.BANNED);
  assert.ok(logs.some((l) => l.includes('half-open')));
  // frames from the abandoned socket are ignored
  FakeWS.instances[0].push({ op: 0, s: 99, t: 'C2C_MESSAGE_CREATE', d: { id: 'late' } });
  assert.notStrictEqual(gw.seq, 99);
  FakeWS.onCreate = null;
});

test('op 7 reconnect -> resume after 1s; op 9 resumable -> resume same session; op 9 false -> identify + token refresh', async () => {
  FakeWS.instances = [];
  const store = memStore(); let tokenCalls = 0;
  const tokens = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: makeFetch((c) => {
    if (c.url === Q.TOKEN_URL) { tokenCalls++; return { body: { access_token: 'TOK', expires_in: '7200' } }; }
    return { body: { url: 'wss://fake/websocket' } };
  }) });
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    ws.onSend = (m) => {
      if (idx === 0 && m.op === 2) { ws.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'S1' } }); ws.push({ op: 7, d: null }); }
      if (idx === 1 && m.op === 6) ws.push({ op: 9, d: true });
      if (idx === 2 && m.op === 6) ws.push({ op: 9, d: false });
      if (idx === 3 && m.op === 2) setImmediate(() => ws.serverClose(4914));
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 10000 } });
  };
  const logs = []; const delays = [];
  const gw = new Gateway({ tokens, onC2C: async () => {}, store, fetchImpl: tokens.fetchImpl, WebSocketImpl: FakeWS,
    logFn: (m) => logs.push(m), sleep: async (ms) => { delays.push(ms); }, hbJitterMaxMs: 5, backoff: zeroBackoff(), clock: null });
  await assert.rejects(gw.run(), (e) => e.fatal === Q.FATAL.BANNED);
  const I = FakeWS.instances;
  assert.ok(I[0].sent.some((m) => m.op === 2));
  assert.strictEqual(I[1].sent.find((m) => m.op === 6).d.session_id, 'S1');
  assert.strictEqual(I[2].sent.find((m) => m.op === 6).d.session_id, 'S1');
  assert.ok(I[3].sent.some((m) => m.op === 2) && !I[3].sent.some((m) => m.op === 6));
  assert.deepStrictEqual(delays, [1000, 3000, 3000]);
  assert.strictEqual(tokenCalls, 2, 'token refreshed after non-resumable op 9');
  assert.ok(logs.some((l) => l.startsWith('op 7:')) && logs.some((l) => l.includes('resumable=false')));
  FakeWS.onCreate = null;
});

test('watchdog: no frame for the stale window -> forced resume', async () => {
  FakeWS.instances = [];
  const store = memStore();
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    ws.onSend = (m) => {
      if (idx === 0 && m.op === 2) ws.push({ op: 0, s: 3, t: 'READY', d: { session_id: 'S1' } }); // then silence
      if (idx === 1 && m.op === 6) setImmediate(() => ws.serverClose(4914));
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 60000 } }); // heartbeat checks too slow to fire in this test
  };
  const { gw, logs } = liveGw(store, { watchdogEveryMs: 20, watchdogStaleMs: 50 });
  await assert.rejects(gw.run(), (e) => e.fatal === Q.FATAL.BANNED);
  assert.ok(logs.some((l) => /^watchdog: no gateway frame for \d+s, forcing resume$/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => l.includes('local=watchdog')));
  assert.deepStrictEqual(FakeWS.instances[1].sent.find((m) => m.op === 6).d.seq, 3);
  FakeWS.onCreate = null;
});

test('watchdog: healthy connection is left alone', async () => {
  FakeWS.instances = [];
  const store = memStore();
  FakeWS.onCreate = (ws) => {
    ws.onSend = (m) => {
      if (m.op === 2) ws.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'S1' } });
      if (m.op === 1) ws.push({ op: 11 });
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 10 } });
    setTimeout(() => ws.serverClose(4914), 150);
  };
  const { gw, logs } = liveGw(store, { watchdogEveryMs: 20, watchdogStaleMs: 50 });
  await assert.rejects(gw.run(), (e) => e.fatal === Q.FATAL.BANNED);
  assert.strictEqual(FakeWS.instances.length, 1);
  assert.ok(!logs.some((l) => l.startsWith('watchdog')));
  assert.ok(gw.stats.hbAcked >= 5);
  FakeWS.onCreate = null;
});

/* ---------------- new anti-disconnect features ---------------- */
test('stale detection: socket silent for ~2 heartbeat intervals (ESTABLISHED but no events) -> forced RESUME', async () => {
  FakeWS.instances = [];
  const store = memStore();
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    ws.onSend = (m) => {
      // connection 0: answers IDENTIFY, ACKs exactly one heartbeat, then goes completely silent (like after a host suspend)
      if (idx === 0 && m.op === 2) ws.push({ op: 0, s: 4, t: 'READY', d: { session_id: 'S1' } });
      if (idx === 0 && m.op === 1 && !ws.acked) { ws.acked = true; ws.push({ op: 11 }); }
      if (idx === 1 && m.op === 6) setImmediate(() => ws.serverClose(4914));
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 30 } });
  };
  const t0 = Date.now();
  const { gw, logs } = liveGw(store);
  await assert.rejects(gw.run(), (e) => e.fatal === Q.FATAL.BANNED);
  const took = Date.now() - t0;
  assert.ok(logs.some((l) => l.includes('local=zombie') || l.includes('local=stale')), logs.join('\n'));
  assert.ok(took < 30 * 6, `detected within a few intervals (${took}ms)`);
  assert.deepStrictEqual(FakeWS.instances[1].sent.find((m) => m.op === 6).d, { token: 'QQBot TOK', session_id: 'S1', seq: 4 });
  FakeWS.onCreate = null;
});

test('clock jump (host suspend/resume) forces reconnect + RESUME; onState and onAlive reported', async () => {
  FakeWS.instances = [];
  const store = memStore(); const states = []; let alive = 0;
  let gwRef = null;
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    ws.onSend = (m) => {
      if (m.op === 1) ws.push({ op: 11 });
      if (idx === 0 && m.op === 2) { ws.push({ op: 0, s: 7, t: 'READY', d: { session_id: 'S1' } }); setTimeout(() => gwRef.onClockJump(3_600_000), 20); }
      if (idx === 1 && m.op === 6) { ws.push({ op: 0, s: 8, t: 'RESUMED', d: '' }); setTimeout(() => ws.serverClose(4915), 5); }
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 10000 } });
  };
  const { gw, logs, delays } = liveGw(store, { onState: (s) => states.push(s), onAlive: () => { alive++; } });
  gwRef = gw;
  await assert.rejects(gw.run(), (e) => e.fatal === Q.FATAL.BANNED);
  assert.ok(logs.some((l) => /^clock jump detected \(3600s/.test(l)));
  assert.ok(logs.some((l) => l.includes('local=clock_jump')));
  assert.strictEqual(delays[0], 1000);
  assert.deepStrictEqual(FakeWS.instances[1].sent.find((m) => m.op === 6).d.seq, 7);
  assert.deepStrictEqual(states, ['RUNNING', 'RECONNECTING', 'RUNNING']);
  assert.ok(alive >= 4);
  assert.strictEqual(gw.stats.clockJumps, 1);
  FakeWS.onCreate = null;
});

test('backoff resets after READY so a later outage starts again at 1s', async () => {
  FakeWS.instances = [];
  const store = memStore(); let n = 0;
  const tokens = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: makeFetch((c) => {
    if (c.url === Q.TOKEN_URL) return { body: { access_token: 'TOK', expires_in: '7200' } };
    n++;
    return n <= 3 ? { throw: 'TypeError' } : { body: { url: 'wss://fake/websocket' } }; // 3 failed /gateway calls, then OK
  }) });
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    ws.onSend = (m) => {
      if (m.op === 2) { ws.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'S1' } }); setImmediate(() => ws.serverClose(idx === 0 ? 1006 : 4914)); }
      if (m.op === 6) { ws.push({ op: 0, s: 2, t: 'RESUMED', d: '' }); setImmediate(() => ws.serverClose(4914)); }
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 10000 } });
  };
  const delays = [];
  const gw = new Gateway({ tokens, onC2C: async () => {}, store, fetchImpl: tokens.fetchImpl, WebSocketImpl: FakeWS, logFn: () => {},
    sleep: async (ms) => { delays.push(ms); }, hbJitterMaxMs: 5, backoff: zeroBackoff(), clock: null });
  await assert.rejects(gw.run(), (e) => e.fatal === Q.FATAL.BANNED);
  assert.deepStrictEqual(delays, [1000, 2000, 4000, 1000]);
  FakeWS.onCreate = null;
});

test('default backoff applies jitter within bounds', () => {
  const b = new Backoff({ baseMs: 1000, maxMs: 60_000 });
  for (let i = 0; i < 10; i++) { const cap = Math.min(60_000, 1000 * 2 ** i); const d = b.next(); assert.ok(d <= cap && d >= cap * 0.7 - 1, `${d} vs ${cap}`); }
});

/* ---------------- CLI (no network) ---------------- */
function runNode(args, env = {}, opts = {}) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 10000, ...opts,
    env: { PATH: process.env.PATH, BRIDGE_NO_DOTENV: '1', STATE_DIR: path.join(TMP, 'cli-state'), LOG_DIR: path.join(TMP, 'cli-logs'), ...env } });
}
const APP = { QQBOT_APP_ID: '1000000001', QQBOT_APP_SECRET: 'fakesecret' };

test('CLI config validation: bridge --check exits 2 with clear messages', () => {
  let r = runNode(['bin/bridge.js', '--check']);
  assert.strictEqual(r.status, 2);
  for (const k of ['FORWARD_WEBHOOK_URL is required', 'QQBOT_APP_ID is required', 'QQBOT_APP_SECRET is required']) assert.ok(r.stderr.includes(k), k);
  r = runNode(['bin/bridge.js', '--check'], { ...APP, QQBOT_APP_ID: 'abc', FORWARD_WEBHOOK_URL: 'https://hooks.example.com/x', OWNER_PROTECTION: 'kinda' });
  assert.strictEqual(r.status, 2); assert.match(r.stderr, /QQBOT_APP_ID must be numeric/); assert.match(r.stderr, /OWNER_PROTECTION/);
  r = runNode(['bin/bridge.js', '--check'], { ...APP, FORWARD_WEBHOOK_URL: 'https://hooks.example.com/x', MIRROR_TO_MAIN_CHAT: 'false' });
  assert.strictEqual(r.status, 0, r.stderr); assert.match(r.stdout, /protection off, mirror false/);
  r = runNode(['bin/bridge.js', '--check'], { ...APP, FORWARD_WEBHOOK_URL: 'https://hooks.example.com/x' });
  assert.match(r.stdout, /protection off, mirror true/, 'defaults');
  r = runNode(['bin/bridge.js', '--check'], { ...APP, FORWARD_WEBHOOK_URL: 'https://hooks.example.com/x', OWNER_PROTECTION: 'on' });
  assert.match(r.stdout, /protection on, mirror true/);
  assert.ok(!(r.stdout + r.stderr).includes('fakesecret'));
});

test('CLI reply: EMPTY_TEXT, NO_RECIPIENT, image validation before network', () => {
  const env = { ...APP };
  assert.strictEqual(runNode(['bin/reply.js'], env, { input: '' }).stdout.trim(), 'ERROR EMPTY_TEXT');
  const r = runNode(['bin/reply.js', 'hi'], env);
  assert.strictEqual(r.stdout.trim(), 'ERROR NO_RECIPIENT'); assert.strictEqual(r.status, 2, '--to is required (usage error)');
  assert.strictEqual(runNode(['bin/reply.js', '--image'], env).stdout.trim(), 'ERROR NO_FILE');
  assert.strictEqual(runNode(['bin/reply.js', '--image', path.join(TMP, 'nope.png')], env).stdout.trim(), 'ERROR FILE_NOT_FOUND');
  fs.writeFileSync(path.join(TMP, 'cli-fake.png'), 'text');
  assert.strictEqual(runNode(['bin/reply.js', '--image', path.join(TMP, 'cli-fake.png')], env).stdout.trim(), 'ERROR UNSUPPORTED_TYPE');
  const big = path.join(TMP, 'cli-big.gif'); fs.writeFileSync(big, 'GIF89a'); fs.truncateSync(big, 11 * 1024 * 1024);
  const rb = runNode(['bin/reply.js', '--image', big], env);
  assert.strictEqual(rb.stdout.trim(), 'ERROR FILE_TOO_LARGE'); assert.match(rb.stderr, /limit is 10MB/);
  fs.writeFileSync(path.join(TMP, 'cli-ok.png'), PNG_BYTES);
  const rr = spawnSync('bash', [path.join(ROOT, 'reply.sh'), '--image', 'cli-ok.png', 'caption'], { cwd: TMP, encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, BRIDGE_NO_DOTENV: '1', STATE_DIR: path.join(TMP, 'cli-state'), LOG_DIR: path.join(TMP, 'cli-logs'), ...env } });
  assert.strictEqual(rr.stdout.trim(), 'ERROR NO_RECIPIENT', rr.stderr); // relative path resolved from the caller's cwd
  assert.ok(!(r.stdout + r.stderr + rb.stdout + rb.stderr + rr.stdout + rr.stderr).includes('fakesecret'));
});

test('CLI bridge with fake fetch: 100016 -> BAD_CREDENTIALS exit 16, STATUS written, healthcheck exit 2, no secrets in logs', () => {
  const st = path.join(TMP, 'cli2-state'); const lg = path.join(TMP, 'cli2-logs');
  const env = { ...APP, FORWARD_WEBHOOK_URL: 'https://hook.example.com/x', FORWARD_WEBHOOK_AUTH: 'Bearer fakekey', STATE_DIR: st, LOG_DIR: lg };
  const r = runNode(['-r', path.join(__dirname, 'fake-fetch-preload.js'), 'bin/bridge.js'], env);
  assert.strictEqual(r.status, 16, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(st, 'STATUS'), 'utf8').trim(), 'BAD_CREDENTIALS');
  const logText = fs.readFileSync(path.join(lg, 'bridge.log'), 'utf8');
  for (const secret of ['1000000001', 'fakesecret', 'fakekey', 'hook.example.com']) assert.ok(!logText.includes(secret), secret);
  assert.strictEqual(fs.statSync(st).mode & 0o777, 0o700);
  for (const f of fs.readdirSync(st)) assert.strictEqual(fs.statSync(path.join(st, f)).mode & 0o777, 0o600, f);
  assert.strictEqual(fs.statSync(path.join(lg, 'bridge.log')).mode & 0o777, 0o600);
  const h = runNode(['bin/healthcheck.js'], { STATE_DIR: st });
  assert.strictEqual(h.status, 2); assert.match(h.stdout, /UNHEALTHY BAD_CREDENTIALS: .*AppSecret/);
});

test('CLI healthcheck: not running / stale / ok, and --status summary', (t) => {
  const st = path.join(TMP, 'hc-state'); fs.mkdirSync(st, { recursive: true });
  const env = { STATE_DIR: st };
  fs.writeFileSync(path.join(st, 'STATUS'), 'STOPPED\n');
  assert.strictEqual(runNode(['bin/healthcheck.js'], env).status, 1);
  fs.writeFileSync(path.join(st, 'STATUS'), 'RECONNECTING\n');
  const fakeBridge = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'bin/bridge.js'], { stdio: 'ignore' }); // cmdline ends in bin/bridge.js
  t.after(() => fakeBridge.kill());
  fs.writeFileSync(path.join(st, 'bridge.pid'), `${fakeBridge.pid}\n`);
  fs.writeFileSync(path.join(st, 'HEARTBEAT'), `${Date.now() - 900_000}\n`);
  const s = runNode(['bin/healthcheck.js'], env);
  assert.strictEqual(s.status, 3); assert.match(s.stdout, /no successful activity for 900s/);
  fs.writeFileSync(path.join(st, 'STATUS'), 'RUNNING\n');
  fs.writeFileSync(path.join(st, 'HEARTBEAT'), `${Date.now()}\n`);
  assert.strictEqual(runNode(['bin/healthcheck.js'], env).status, 0);
  const v = runNode(['bin/healthcheck.js', '--status'], { ...env, OWNER_PROTECTION: 'off', MIRROR_TO_MAIN_CHAT: 'false' });
  assert.match(v.stdout, /protection: +off/); assert.match(v.stdout, /mirror: +false/);
});

test('outbound-only: no server or listening socket in the code', () => {
  const files = [...fs.readdirSync(path.join(ROOT, 'src')).map((f) => path.join('src', f)), ...fs.readdirSync(path.join(ROOT, 'bin')).map((f) => path.join('bin', f))];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/createServer|\.listen\(|require\(['"](node:)?(http|net|dgram)['"]\)/.test(src), f);
  }
});

'use strict';
// QQ media tests: inbound C2C attachments (images, voice with asr_refer_text / voice_wav_url, files), payload shape,
// outbound voice and file uploads, and error cases. No network: fetch is faked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Q = require('../src/qq');
const { collectAttachments, fetchMedia, normalizeUrl, kindOf } = require('../src/media');
const { createMediaStore } = require('../src/media-store');
const { makeC2CHandler } = require('../src/handler');
const { createGuard } = require('../src/guard');
const { sendVoice, sendFile, sendMedia, loadVoice, loadFile } = require('../src/reply');
const { parseArgs } = require('../bin/reply');
const { makeFetch, memStore, memOwner } = require('./fakes');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-qqbot-media-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const OWNER = 'ABCDEF1234567890ABCDEF1234567890';
const STRANGER = 'ZZZZZZ9999999999ZZZZZZ9999999999';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png')]);
const SILK = Buffer.from('\x02#!SILK_V3 fake frames');
const WAV = Buffer.from('RIFF\0\0\0\0WAVEfmt fake');
const MP3 = Buffer.from('ID3\x04\0\0 fake mp3');

function binFetch(routes) {
  const calls = [];
  const f = async (url) => {
    const u = String(url); calls.push(u);
    const hit = Object.keys(routes).find((k) => u.includes(k));
    const r = hit ? routes[hit] : { status: 404 };
    const body = Buffer.isBuffer(r) ? r : r.body || Buffer.alloc(0); const status = r.status || 200;
    return { ok: status < 300, status, headers: { get: () => null }, text: async () => '', arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  f.calls = calls;
  return f;
}
const store = (name, maxBytes = 1024 * 1024) => createMediaStore({ dir: path.join(TMP, name), maxBytes, allowedHosts: ['example.com'] });
const ev = (id, openid, content, attachments) => ({ id, author: { user_openid: openid }, content, attachments });

/* ---------------- inbound ---------------- */
test('collect: kinds from content_type / filename, "//" URLs completed, transcripts, empty attachments ignored', () => {
  assert.strictEqual(normalizeUrl('//multimedia.nt.qq.com.cn/x'), 'https://multimedia.nt.qq.com.cn/x');
  assert.deepStrictEqual([kindOf({ content_type: 'image/jpeg' }), kindOf({ content_type: 'voice' }), kindOf({ content_type: 'file', filename: 'a.amr' }),
    kindOf({ content_type: 'video/mp4' }), kindOf({ content_type: 'file', filename: 'a.pdf' })], ['image', 'voice', 'voice', 'video', 'file']);
  const c = collectAttachments(ev('1', OWNER, '', [{}, { content_type: 'image/png', url: '//cdn.example.com/i' },
    { content_type: 'voice', url: 'https://cdn.example.com/v', asr_refer_text: ' hi bot ' }, { content_type: 'voice', asr_refer_text: 'text only' }]));
  assert.deepStrictEqual(c.map((x) => [x.kind, x.transcript]), [['image', ''], ['voice', 'hi bot'], ['voice', 'text only']]);
});

test('download: image keeps content_type + size; voice prefers voice_wav_url; SILK transcoded; file name; errors kept', async () => {
  const f = binFetch({ '/img': PNG, '/v.wav': WAV, '/v.silk': SILK, '/doc': Buffer.from('%PDF-1.7'), '/gone': { status: 403 } });
  const s = store('dl');
  const atts = [
    { content_type: 'image/png', url: 'https://cdn.example.com/img', width: 10, height: 20, size: PNG.length },
    { content_type: 'voice', url: 'https://cdn.example.com/v.silk', voice_wav_url: 'https://cdn.example.com/v.wav', asr_refer_text: 'hello' },
    { content_type: 'voice', url: 'https://cdn.example.com/v.silk' },
    { content_type: 'file', filename: 'notes.pdf', url: 'https://cdn.example.com/doc' },
    { content_type: 'image/png', url: 'https://cdn.example.com/gone' },
    { content_type: 'image/png', url: 'http://cdn.example.com/img' },
    { content_type: 'file', filename: 'huge.zip', url: 'https://cdn.example.com/doc', size: 5 * 1024 * 1024 },
  ];
  let transcoded = 0;
  const out = await fetchMedia(collectAttachments({ attachments: atts }), { store: s, fetchImpl: f, transcode: async () => { transcoded++; return WAV; } });
  assert.deepStrictEqual(out.map((e) => [e.kind, e.content_type, e.error || null]), [
    ['image', 'image/png', null], ['voice', 'audio/wav', null], ['voice', 'audio/wav', null], ['file', 'application/pdf', null],
    ['image', null, 'HTTP_403'], ['image', null, 'NOT_HTTPS'], ['file', null, 'TOO_LARGE']]);
  assert.deepStrictEqual([out[0].width, out[0].height, out[0].size], [10, 20, PNG.length]);
  assert.ok(fs.readFileSync(out[0].path).equals(PNG));
  assert.strictEqual(out[1].transcript, 'hello'); assert.ok(fs.readFileSync(out[1].path).equals(WAV));
  assert.strictEqual(transcoded, 1);
  assert.deepStrictEqual([out[3].filename, out[6].filename], ['notes.pdf', 'huge.zip']);
  assert.ok(!f.calls.some((u) => u.startsWith('http:')));
  assert.strictEqual(f.calls.filter((u) => u.endsWith('/v.silk')).length, 1, 'wav url used when present');
  const [raw] = await fetchMedia(collectAttachments({ attachments: [atts[2]] }), { store: s, fetchImpl: f, transcode: async () => null });
  assert.deepStrictEqual([raw.content_type, path.extname(raw.path)], ['audio/silk', '.silk']);
  const [only] = await fetchMedia(collectAttachments({ attachments: [{ content_type: 'voice', asr_refer_text: 'just text' }] }), { store: s, fetchImpl: f });
  assert.deepStrictEqual(only, { kind: 'voice', transcript: 'just text', path: null, content_type: null, size: null });
});

function c2c({ protection = true, media = true, rate = 20 } = {}) {
  const st = memStore(); const fwd = []; const fetched = [];
  const guard = createGuard({ protection, ownerStore: memOwner(OWNER), rateLimitPerMin: rate, maxChars: 4000 });
  const h = makeC2CHandler({ store: st, guard, forward: async (p) => { fwd.push(p); return true; }, now: () => 1000,
    fetchMedia: media ? async (c) => { fetched.push(...c); return c.map((x) => ({ kind: x.kind, path: `/m/${x.kind}`, content_type: 'x/y', size: 1, ...(x.transcript ? { transcript: x.transcript } : {}) })); } : null });
  return { st, fwd, fetched, guard, h };
}

test('handler: media-only forwarded with media array; asr transcript in text; reply window saved', async () => {
  const t = c2c();
  assert.strictEqual(await t.h(ev('m1', OWNER, '', [{ content_type: 'image/png', url: 'https://cdn.example.com/i' }])), 'forwarded');
  assert.strictEqual(await t.h(ev('m2', OWNER, '', [{ content_type: 'voice', url: 'https://cdn.example.com/v', asr_refer_text: 'what time is it' }])), 'forwarded');
  assert.strictEqual(await t.h(ev('m3', OWNER, ' caption ', [{ content_type: 'image/gif', url: 'https://cdn.example.com/g' }])), 'forwarded');
  assert.deepStrictEqual(t.fwd.map((p) => [p.text, p.media.map((m) => m.kind)]), [['', ['image']], ['[voice] what time is it', ['voice']], ['caption', ['image']]]);
  assert.strictEqual(t.fwd[1].media[0].transcript, 'what time is it');
  assert.deepStrictEqual(Object.keys(t.fwd[0]), ['source', 'sender_id', 'message_id', 'text', 'truncated', 'received_at', 'untrusted', 'mirror', 'media', 'handling_hint']);
  assert.deepStrictEqual(t.st.getLastMsg(OWNER), { msg_id: 'm3', received_ms: 1000 });
});

test('handler: stranger media dropped without download; rate limit; ACCEPT_MEDIA off keeps transcripts only', async () => {
  const t = c2c({ rate: 1 });
  assert.strictEqual(await t.h(ev('s1', STRANGER, '', [{ content_type: 'image/png', url: 'https://cdn.example.com/i' }])), 'dropped');
  assert.strictEqual(await t.h(ev('o1', OWNER, '', [{ content_type: 'image/png', url: 'https://cdn.example.com/i' }])), 'forwarded');
  assert.strictEqual(await t.h(ev('o2', OWNER, '', [{ content_type: 'image/png', url: 'https://cdn.example.com/i' }])), 'rate_limited');
  assert.strictEqual(t.fetched.length, 1);
  const off = c2c({ media: false });
  assert.strictEqual(await off.h(ev('a', OWNER, '', [{ content_type: 'image/png', url: 'https://cdn.example.com/i' }])), 'non_text');
  assert.strictEqual(await off.h(ev('b', OWNER, '', [{ content_type: 'voice', url: 'https://cdn.example.com/v', asr_refer_text: 'hey' }])), 'forwarded');
  assert.deepStrictEqual([off.fwd[0].text, 'media' in off.fwd[0]], ['[voice] hey', false]);
});

test('handler + real downloader: files land in MEDIA_DIR and the payload points at them', async () => {
  const st = memStore(); const fwd = []; const s = store('int');
  const guard = createGuard({ protection: false, ownerStore: memOwner(null) });
  const f = binFetch({ '/pic': PNG });
  const h = makeC2CHandler({ store: st, guard, forward: async (p) => { fwd.push(p); return true; }, fetchMedia: (c) => fetchMedia(c, { store: s, fetchImpl: f }) });
  assert.strictEqual(await h(ev('x1', OWNER, '', [{ content_type: 'image/png', filename: 'a.png', url: '//cdn.example.com/pic' }])), 'forwarded');
  const m = fwd[0].media[0];
  assert.strictEqual(path.dirname(m.path), s.dir); assert.ok(fs.readFileSync(m.path).equals(PNG));
  assert.deepStrictEqual(f.calls, ['https://cdn.example.com/pic']);
});

/* ---------------- outbound voice / file ---------------- */
function mediaHarness({ lastMs, upload, respond } = {}) {
  const st = memStore();
  if (lastMs !== undefined) st.s.lastMsgs[OWNER] = { msg_id: 'M1', received_ms: lastMs };
  const uploads = []; const sends = [];
  const f = makeFetch((c) => {
    if (c.url === Q.TOKEN_URL) return { body: { access_token: 'T', expires_in: '7200' } };
    if (c.url.endsWith(`/v2/users/${OWNER}/files`)) { uploads.push(c.body); return upload ? upload(c.body) : { body: { file_info: 'FI' } }; }
    sends.push(c.body); return respond ? respond(c.body) : { body: { id: 'R' } };
  });
  const tokens = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: f });
  const deps = { to: OWNER, tokens, store: st, fetchImpl: f, now: () => 10_000 };
  return { uploads, sends, st, deps };
}
const file = (name, buf) => { const p = path.join(TMP, name); fs.writeFileSync(p, buf); return p; };

test('voice: silk / wav / mp3 uploaded as file_type 3 (base64), passive msg_type 7, no empty content', async () => {
  for (const [name, buf, kind] of [['v.silk', SILK, 'silk'], ['v.wav', WAV, 'wav'], ['v.mp3', MP3, 'mp3']]) {
    const h = mediaHarness({ lastMs: 0 });
    const r = await sendVoice(file(name, buf), '', h.deps);
    assert.deepStrictEqual(h.uploads, [{ file_type: 3, srv_send_msg: false, file_data: buf.toString('base64') }]);
    assert.deepStrictEqual(h.sends, [{ msg_type: 7, media: { file_info: 'FI' }, msg_id: 'M1', msg_seq: 1 }]);
    assert.deepStrictEqual([r.kind, r.passive], [kind, 1]);
  }
  assert.strictEqual(loadVoice(file('named.mp3', SILK)).kind, 'silk', 'detected by content, not extension');
  assert.throws(() => loadVoice(file('v.ogg', Buffer.from('OggS....'))), (e) => e.label === 'UNSUPPORTED_TYPE');
  assert.throws(() => loadVoice(path.join(TMP, 'none.silk')), (e) => e.label === 'FILE_NOT_FOUND');
  assert.throws(() => loadVoice(file('e.silk', Buffer.alloc(0))), (e) => e.label === 'EMPTY_FILE');
  assert.throws(() => loadVoice(file('l.silk', SILK), { maxBytes: 4 }), (e) => e.label === 'FILE_TOO_LARGE');
});

test('file: file_type 4 with file_name, caption as content; active when no passive window; errors carry stage', async () => {
  const h = mediaHarness({});
  const r = await sendFile(file('report 2026.pdf', Buffer.from('%PDF-1.4 x')), '**see** attached', h.deps);
  assert.deepStrictEqual(h.uploads, [{ file_type: 4, srv_send_msg: false, file_data: Buffer.from('%PDF-1.4 x').toString('base64'), file_name: 'report 2026.pdf' }]);
  assert.deepStrictEqual(h.sends, [{ msg_type: 7, media: { file_info: 'FI' }, content: 'see attached' }]);
  assert.strictEqual(r.active, 1);
  assert.strictEqual(loadFile(file('any.bin', Buffer.from([0, 1, 2]))).name, 'any.bin');
  const bad = mediaHarness({ upload: () => ({ status: 400, body: { code: 850012 } }) });
  await assert.rejects(sendFile(file('f.txt', Buffer.from('x')), '', bad.deps), (e) => e.label === '850012' && e.stage === 'upload');
  const bad2 = mediaHarness({ respond: () => ({ status: 400, body: { code: 40054013 } }) });
  await assert.rejects(sendVoice(file('v2.silk', SILK), '', bad2.deps), (e) => e.label === '40054013' && e.stage === 'send');
  await assert.rejects(sendMedia('video', file('x.mp4', Buffer.from('x')), '', h.deps), (e) => e.label === 'UNSUPPORTED_KIND');
  await assert.rejects(sendVoice(file('v3.silk', SILK), '', { ...h.deps, to: '' }), (e) => e.label === 'NO_RECIPIENT');
});

/* ---------------- CLI ---------------- */
function runReply(args) {
  return spawnSync(process.execPath, ['bin/reply.js', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, BRIDGE_NO_DOTENV: '1', STATE_DIR: path.join(TMP, 'cli-state'), LOG_DIR: path.join(TMP, 'cli-logs'),
      QQBOT_APP_ID: '1000000001', QQBOT_APP_SECRET: 'fakesecret' } });
}

test('CLI reply: --voice / --file validated before any network call; one media flag per call', () => {
  assert.deepStrictEqual(parseArgs(['--to', 'u', 'hi']), { to: 'u', image: '', rest: ['hi'] });
  assert.deepStrictEqual(parseArgs(['--voice', 'a.silk', 'cap']), { to: '', image: '', rest: ['cap'], kind: 'voice', voice: 'a.silk' });
  assert.strictEqual(runReply(['--voice', path.join(TMP, 'missing.silk')]).stdout.trim(), 'ERROR FILE_NOT_FOUND');
  assert.strictEqual(runReply(['--voice', file('bad.silk', Buffer.from('nope'))]).stdout.trim(), 'ERROR UNSUPPORTED_TYPE');
  assert.strictEqual(runReply(['--file']).stdout.trim(), 'ERROR NO_FILE');
  assert.strictEqual(runReply(['--image', 'a.png', '--voice', 'b.silk']).stdout.trim(), 'ERROR USAGE');
  assert.strictEqual(runReply(['--voice', file('ok.silk', SILK)]).stdout.trim(), 'ERROR NO_RECIPIENT');
  assert.strictEqual(runReply(['--file', file('ok.txt', Buffer.from('x'))]).stdout.trim(), 'ERROR NO_RECIPIENT');
});

test('handler: forwarded counter only counts webhook successes; failures count as undelivered', async () => {
  const guard = createGuard({ protection: false, ownerStore: memOwner(null) });
  let ok = false;
  const h = makeC2CHandler({ store: memStore(), guard, forward: async () => ok, now: () => 1000, fetchMedia: null });
  assert.strictEqual(await h(ev('u1', OWNER, 'hi')), 'undelivered');
  assert.strictEqual(guard.stats.forwarded, 0);
  assert.strictEqual(guard.stats.undelivered, 1);
  ok = true;
  assert.strictEqual(await h(ev('u2', OWNER, 'hi again')), 'forwarded');
  assert.strictEqual(guard.stats.forwarded, 1);
  assert.strictEqual(guard.stats.undelivered, 1);
});

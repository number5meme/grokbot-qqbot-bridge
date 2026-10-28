'use strict';
// QQ hardening tests: serial queue, salvage on stop, op 9 backoff, API base check, REPLY_WINDOW, --to / --stdin,
// reply lock, and process-level checks (single instance, graceful stop, shell scripts). No network, no TTY:
// fetch and WebSocket are faked (test/fake-gateway-preload.js).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync, spawn } = require('node:child_process');
const Q = require('../src/qq');
const { Gateway } = require('../src/gateway');
const { makeC2CHandler } = require('../src/handler');
const { createSerialQueue } = require('../src/queue');
const { sendReply, sendImage } = require('../src/reply');
const { createGuard } = require('../src/guard');
const { stripMarkdown } = require('../src/text');
const { Backoff } = require('../src/backoff');
const { makeFetch, FakeWS, memStore, memOwner } = require('./fakes');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-hardening-'));
const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fake-gateway-preload.js');
const OWNER = 'ABCDEF1234567890ABCDEF1234567890';
const APP = { QQBOT_APP_ID: '1000000001', QQBOT_APP_SECRET: 'fakesecret' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex');
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env(extra = {}) {
  return { PATH: process.env.PATH, BRIDGE_NO_DOTENV: '1', ...APP, FORWARD_WEBHOOK_URL: 'https://hook.example/in', ...extra };
}
function runNode(args, extra = {}, opts = {}) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 15000, input: '', ...opts, env: env(extra) });
}
function stateFor(name) { const st = path.join(TMP, name, 'state'); const lg = path.join(TMP, name, 'logs'); fs.mkdirSync(st, { recursive: true }); return { st, lg, STATE_DIR: st, LOG_DIR: lg }; }
function sentBodies(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); }
  throw new Error('timed out waiting');
}

/* ---- #3 serial queue ---- */
test('serial queue: one at a time in order; overflow refused; drain and unfinished', async () => {
  const order = []; let active = 0; let maxActive = 0; let overflow = 0;
  const q = createSerialQueue({ maxPending: 2, onOverflow: () => overflow++,
    worker: async (x) => { active++; maxActive = Math.max(maxActive, active); await sleep(20); order.push(x); active--; } });
  assert.deepStrictEqual([q.push(1), q.push(2), q.push(3), q.push(4)], [true, true, true, false]);
  assert.strictEqual(overflow, 1);
  assert.strictEqual(await q.drain(2000), true);
  assert.deepStrictEqual(order, [1, 2, 3]); assert.strictEqual(maxActive, 1);
  const q2 = createSerialQueue({ worker: () => sleep(200) });
  q2.push('a'); q2.push('b'); q2.push('c');
  assert.strictEqual(await q2.drain(30), false);
  const u = q2.takeUnfinished();
  assert.strictEqual(u.current, 'a'); assert.deepStrictEqual(u.waiting, ['b', 'c']);
  q2.close(); assert.strictEqual(q2.push('d'), false);
  const errs = []; const q3 = createSerialQueue({ worker: () => { throw new Error('boom'); }, onError: (e) => errs.push(e.message) });
  q3.push(1); await q3.drain(); assert.deepStrictEqual(errs, ['boom']);
});

/* ---- #13 salvage ---- */
test('handler salvage: in-flight and queued messages become interrupted undelivered payloads (guard and dedupe apply)', async () => {
  const store = memStore();
  const guard = createGuard({ protection: true, ownerStore: memOwner(OWNER) });
  let release; const gate = new Promise((r) => { release = r; });
  const h = makeC2CHandler({ store, guard, forward: async () => { await gate; return true; } });
  const ev = (id, who, content) => ({ id, author: { user_openid: who }, content, message_type: 0 });
  const p = h(ev('m1', OWNER, 'first'));
  await sleep(10);
  assert.strictEqual(h.inflight.size, 1);
  const n = h.salvage([ev('m2', OWNER, 'second'), ev('m3', 'STRANGER0000', 'nope'), ev('m1', OWNER, 'dup'),
    { ...ev('m4', OWNER, 'pic'), attachments: [{ content_type: 'image/png', url: 'https://x.qq.com/a' }] }]);
  assert.strictEqual(n, 3);
  assert.deepStrictEqual(store.s.undelivered.map((u) => [u.message_id, u.text, u.interrupted]), [['m1', 'first', true], ['m2', 'second', true], ['m4', 'pic', true]]);
  assert.strictEqual(store.s.undelivered[2].attachments, 1);
  assert.ok(store.s.undelivered.every((u) => u.untrusted === true));
  release(); await p;
});

/* ---- #30 op 9 backoff ---- */
test('gateway: repeated op 9 backs off (>= 3 s, growing) instead of a fixed 3 s', async () => {
  FakeWS.instances = [];
  const store = memStore();
  const tokens = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: makeFetch((c) => (c.url === Q.TOKEN_URL
    ? { body: { access_token: 'TOK', expires_in: '7200' } } : { body: { url: 'wss://fake/websocket' } })) });
  FakeWS.onCreate = (ws) => {
    const idx = FakeWS.instances.indexOf(ws);
    ws.onSend = (m) => {
      if (m.op !== 2) return;
      if (idx < 6) ws.push({ op: 9, d: false });
      else setImmediate(() => ws.serverClose(4914));
    };
    ws.open(); ws.push({ op: 10, d: { heartbeat_interval: 10000 } });
  };
  const delays = [];
  const gw = new Gateway({ tokens, onC2C: async () => {}, store, fetchImpl: tokens.fetchImpl, WebSocketImpl: FakeWS, logFn: () => {},
    sleep: async (ms) => { delays.push(ms); }, hbJitterMaxMs: 5, backoff: new Backoff({ baseMs: 1000, maxMs: 60_000, random: () => 0 }), clock: null });
  await assert.rejects(gw.run(), (e) => e.fatal === Q.FATAL.BANNED);
  FakeWS.onCreate = null;
  assert.deepStrictEqual(delays, [3000, 3000, 4000, 8000, 16000, 32000]);
});

/* ---- API base must stay on qq.com ---- */
test('config: QQBOT_API_BASE must be https on a qq.com host', () => {
  for (const bad of ['http://api.sgroup.qq.com', 'https://api.example.com', 'https://qq.com.evil.example']) {
    const r = runNode(['bin/bridge.js', '--check'], { QQBOT_API_BASE: bad, STATE_DIR: path.join(TMP, 'cfg') });
    assert.strictEqual(r.status, 2, bad); assert.match(r.stderr, /QQBOT_API_BASE/);
  }
  const ok = runNode(['bin/bridge.js', '--check'], { QQBOT_API_BASE: 'https://sandbox.api.sgroup.qq.com', STATE_DIR: path.join(TMP, 'cfg') });
  assert.strictEqual(ok.status, 0, ok.stderr);
});

/* ---- #6 REPLY_WINDOW ---- */
test('reply: an active message refused after the passive window is flagged replyWindow (text and media)', async () => {
  const store = memStore();
  const f = makeFetch((c) => {
    if (c.url === Q.TOKEN_URL) return { body: { access_token: 'T', expires_in: '7200' } };
    if (c.url.endsWith('/files')) return { body: { file_info: 'FI', file_uuid: 'u', ttl: 60 } };
    return { status: 400, body: { code: 40034100, message: 'no active messages' } };
  });
  const tokens = new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: f });
  await assert.rejects(sendReply('hi', { to: OWNER, tokens, store, fetchImpl: f }), (e) => e.replyWindow === true && e.totalParts === 1);
  const img = path.join(TMP, 'rw.png'); fs.writeFileSync(img, PNG);
  await assert.rejects(sendImage(img, '', { to: OWNER, tokens, store, fetchImpl: f }), (e) => e.replyWindow === true);
  const f2 = makeFetch((c) => (c.url === Q.TOKEN_URL ? { body: { access_token: 'T', expires_in: '7200' } } : { status: 500, body: { code: 1, message: 'x' } }));
  await assert.rejects(sendReply('hi', { to: OWNER, tokens: new Q.TokenManager({ appId: 'A', secret: 'S', fetchImpl: f2 }), store, fetchImpl: f2 }), (e) => !e.replyWindow);
});

test('CLI reply: refused active message -> ERROR REPLY_WINDOW, exit 3', () => {
  const s = stateFor('rw');
  const r = runNode(['--require', PRELOAD, 'bin/reply.js', '--to', OWNER, '--', 'hello'], { ...s, FAKE_SEND: 'refuse' });
  assert.strictEqual(r.stdout.trim(), 'ERROR REPLY_WINDOW'); assert.strictEqual(r.status, 3);
  assert.match(r.stderr, /new message/);
  assert.ok(!(r.stdout + r.stderr).includes('fakesecret'));
});

/* ---- #2 / #5 --to and --stdin ---- */
test('CLI reply: --to is required and validated before any network call', () => {
  const s = stateFor('to');
  const cases = [
    [['--to', '', 'hi'], 2, /^ERROR USAGE --to needs a recipient id, got \(empty\)/],
    [['--to', '--image', 'x.png'], 2, /^ERROR USAGE --to needs a recipient id, got --image/],
    [['--to'], 2, /^ERROR USAGE --to needs a recipient id, got \(missing\)/],
    [['--to', 'a b;rm', 'hi'], 2, /^ERROR USAGE invalid --to/],
    [['--to', '$(id)', 'hi'], 2, /^ERROR USAGE invalid --to/],
    [['hi'], 2, /^ERROR NO_RECIPIENT/],
    [['--to', 'owner', 'hi'], 1, /^ERROR NO_RECIPIENT/],
    [['--stdin', 'text', '--to', OWNER], 2, /^ERROR USAGE use either --stdin or text/],
    [['--to', OWNER, '--image', 'a.png', '--file', 'b.txt'], 2, /^ERROR USAGE/],
  ];
  for (const [args, code, re] of cases) {
    const r = runNode(['--require', path.join(__dirname, 'no-network-preload.js'), 'bin/reply.js', ...args], s);
    assert.strictEqual(r.status, code, `${JSON.stringify(args)}: ${r.stdout}`); assert.match(r.stdout, re, JSON.stringify(args));
    assert.doesNotMatch(r.stdout, /NETWORK_CALLED/);
  }
});

test('CLI reply: --stdin heredoc text is sent verbatim (no shell expansion); --to owner resolves; media caption from stdin', () => {
  const s = stateFor('stdin'); const dumpDir = path.join(TMP, 'stdin-dump');
  const text = 'Line 1 with $(id) and `whoami` and "double" and \'single\' quotes\n-5 degrees; rm -rf ~\n';
  const sh = `"${process.execPath}" --require "${PRELOAD}" bin/reply.js --to '${OWNER}' --stdin <<'EOF'\n${text}EOF\n`;
  let r = spawnSync('bash', ['-c', sh], { cwd: ROOT, encoding: 'utf8', timeout: 15000, env: env({ ...s, FAKE_DUMP: dumpDir }) });
  assert.strictEqual(r.stdout.trim(), 'OK', r.stderr);
  let msgs = sentBodies(dumpDir).filter((c) => /messages$/.test(c.url));
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].body.content, stripMarkdown(text).trim()); // only Markdown is stripped (inline code ticks)
  assert.match(msgs[0].body.content, /\$\(id\) and whoami and "double" and 'single'/);
  assert.ok(msgs[0].url.includes(`/v2/users/${OWNER}/messages`));
  // stdin without --stdin when it is not a terminal (backward compatible)
  r = runNode(['--require', PRELOAD, 'bin/reply.js', '--to', OWNER], { ...s, FAKE_DUMP: dumpDir }, { input: 'piped text' });
  assert.strictEqual(r.stdout.trim(), 'OK', r.stderr);
  // --to owner uses OWNER_ID (or the bound owner)
  fs.rmSync(dumpDir, { recursive: true, force: true });
  r = runNode(['--require', PRELOAD, 'bin/reply.js', '--to', 'owner', '--', 'hi owner'], { ...s, FAKE_DUMP: dumpDir, OWNER_ID: OWNER });
  assert.strictEqual(r.stdout.trim(), 'OK', r.stderr);
  msgs = sentBodies(dumpDir).filter((c) => /messages$/.test(c.url));
  assert.ok(msgs[0].url.includes(OWNER));
  // media caption from stdin
  fs.rmSync(dumpDir, { recursive: true, force: true });
  const img = path.join(TMP, 'cap.png'); fs.writeFileSync(img, PNG);
  r = runNode(['--require', PRELOAD, 'bin/reply.js', '--to', OWNER, '--image', img, '--stdin'], { ...s, FAKE_DUMP: dumpDir }, { input: 'caption from stdin' });
  assert.strictEqual(r.stdout.trim(), 'OK', r.stderr);
  msgs = sentBodies(dumpDir).filter((c) => /messages$/.test(c.url));
  assert.strictEqual(msgs[0].body.content, 'caption from stdin');
  // reply.sh keeps "--" support
  r = spawnSync('bash', [path.join(ROOT, 'reply.sh'), '--to', OWNER, '--', '-5 degrees'], { cwd: TMP, encoding: 'utf8', timeout: 15000,
    env: env({ ...s, FAKE_DUMP: dumpDir, NODE_OPTIONS: `--require ${PRELOAD}` }) });
  assert.strictEqual(r.stdout.trim(), 'OK', r.stderr);
});

/* ---- #8 secrets are not sent ---- */
test('CLI reply: --file refuses .env, state and key files before any network call', () => {
  const s = stateFor('files');
  fs.writeFileSync(path.join(s.st, 'session.json'), '{}');
  const envFile = path.join(TMP, 'files', '.env'); fs.writeFileSync(envFile, 'X=1');
  for (const f of [envFile, path.join(s.st, 'session.json'), path.join(ROOT, 'package.json').replace('package.json', '.git/config')]) {
    if (!fs.existsSync(f)) continue;
    const r = runNode(['--require', path.join(__dirname, 'no-network-preload.js'), 'bin/reply.js', '--to', OWNER, '--file', f], s);
    assert.strictEqual(r.stdout.trim(), 'ERROR FILE_NOT_ALLOWED', f); assert.strictEqual(r.status, 1);
  }
  const ok = path.join(TMP, 'files', 'report.txt'); fs.writeFileSync(ok, 'report');
  const r = runNode(['--require', path.join(__dirname, 'no-network-preload.js'), 'bin/reply.js', '--to', OWNER, '--file', ok], { ...s, REPLY_ALLOWED_DIRS: s.st });
  assert.strictEqual(r.stdout.trim(), 'ERROR FILE_NOT_ALLOWED', 'outside REPLY_ALLOWED_DIRS');
});

/* ---- #16 concurrent replies share msg_seq safely ---- */
test('CLI reply: concurrent calls never reuse a passive msg_seq (reply lock)', async () => {
  const s = stateFor('conc'); const dumpDir = path.join(TMP, 'conc-dump');
  fs.writeFileSync(path.join(s.st, 'last-msgs.json'), JSON.stringify({ [OWNER]: { msg_id: 'M1', received_ms: Date.now() } }));
  const runs = [1, 2, 3].map((i) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--require', PRELOAD, 'bin/reply.js', '--to', OWNER, '--', `msg ${i}`], { cwd: ROOT, env: env({ ...s, FAKE_DUMP: dumpDir }) });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
  }));
  const res = await Promise.all(runs);
  assert.ok(res.every((x) => x.code === 0 && x.out.trim() === 'OK'), JSON.stringify(res));
  const seqs = sentBodies(dumpDir).filter((c) => /messages$/.test(c.url)).map((c) => c.body.msg_seq).sort();
  assert.deepStrictEqual(seqs, [1, 2, 3]);
  assert.ok(!fs.existsSync(path.join(s.st, 'reply.lock')));
});

/* ---- #12 / #13 / #26 process level ---- */
test('bridge process: single instance, forwards over the fake gateway, graceful stop salvages an in-flight message', async (t) => {
  const s = stateFor('proc'); const dumpDir = path.join(TMP, 'proc-dump');
  const c2c = [{ id: 'MSG1', author: { user_openid: OWNER }, content: 'slow one', message_type: 0, timestamp: new Date().toISOString() }];
  const e = env({ ...s, FAKE_DUMP: dumpDir, FAKE_C2C: JSON.stringify(c2c), FAKE_WEBHOOK_MS: '20000', BRIDGE_STOP_GRACE_MS: '300', OWNER_PROTECTION: 'on', OWNER_ID: OWNER });
  const child = spawn(process.execPath, ['--require', PRELOAD, 'bin/bridge.js'], { cwd: ROOT, env: e, stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  await waitFor(() => fs.existsSync(path.join(s.lg, 'bridge.log')) && /inbound text/.test(fs.readFileSync(path.join(s.lg, 'bridge.log'), 'utf8')));
  assert.strictEqual(fs.readFileSync(path.join(s.st, 'STATUS'), 'utf8').trim(), 'RUNNING');
  // a second bridge on the same state folder refuses to start
  const second = runNode(['--require', PRELOAD, 'bin/bridge.js'], { ...s });
  assert.strictEqual(second.status, 2); assert.match(second.stderr, /already running/);
  child.kill('SIGTERM');
  assert.strictEqual(await exited, 0);
  assert.strictEqual(fs.readFileSync(path.join(s.st, 'STATUS'), 'utf8').trim(), 'STOPPED');
  assert.ok(!fs.existsSync(path.join(s.st, 'bridge.pid')));
  const und = fs.readFileSync(path.join(s.st, 'undelivered.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(und.map((u) => [u.message_id, u.text, u.interrupted]), [['MSG1', 'slow one', true]]);
  const log = fs.readFileSync(path.join(s.lg, 'bridge.log'), 'utf8');
  for (const secret of ['fakesecret', 'FAKE_TOKEN', 'hook.example', 'slow one']) assert.ok(!log.includes(secret), secret);
  // replay.sh resends it (fake webhook answers at once now)
  const rp = spawnSync('bash', [path.join(ROOT, 'replay.sh')], { cwd: TMP, encoding: 'utf8', timeout: 15000, env: { ...e, FAKE_WEBHOOK_MS: '0', NODE_OPTIONS: `--require ${PRELOAD}` } });
  assert.strictEqual(rp.status, 0, rp.stderr); assert.match(rp.stdout, /sent=1 failed=0 invalid=0/);
  assert.strictEqual(fs.existsSync(path.join(s.st, 'undelivered.jsonl')) ? fs.readFileSync(path.join(s.st, 'undelivered.jsonl'), 'utf8') : '', '');
});

/* ---- #1 / #11 / #12 / #29 / #31 shell scripts ---- */
test('shell scripts: STATE_DIR/LOG_DIR from .env, idempotent start, PID reuse safe stop, watchdog single instance', async (t) => {
  const dir = path.join(TMP, 'copy');
  fs.mkdirSync(dir);
  for (const n of ['bin', 'src', 'start.sh', 'stop.sh', 'status.sh', 'healthcheck.sh', 'watchdog.sh', 'replay.sh', 'reply.sh', 'package.json']) {
    fs.cpSync(path.join(ROOT, n), path.join(dir, n), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, '.env'), [`QQBOT_APP_ID=${APP.QQBOT_APP_ID}`, `QQBOT_APP_SECRET=${APP.QQBOT_APP_SECRET}`,
    'FORWARD_WEBHOOK_URL=https://hook.example/in', 'STATE_DIR=custom-state', 'LOG_DIR="custom logs"', ''].join('\n'));
  const shEnv = { PATH: process.env.PATH, NODE_OPTIONS: `--require ${PRELOAD}`, START_WAIT: '10', STOP_WAIT: '5', WATCHDOG_INTERVAL: '1' };
  const sh = (script) => spawnSync('bash', [path.join(dir, script)], { cwd: TMP, encoding: 'utf8', timeout: 30000, env: shEnv });
  const st = path.join(dir, 'custom-state'); const lg = path.join(dir, 'custom logs');
  t.after(() => { spawnSync('bash', [path.join(dir, 'stop.sh')], { env: shEnv, timeout: 20000 }); });

  let r = sh('start.sh');
  assert.match(r.stdout, /started \(pid \d+, status RUNNING\)/, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(st, 'bridge.pid')), 'pid file in STATE_DIR from .env');
  assert.ok(fs.existsSync(path.join(lg, 'bridge.log')), 'log in LOG_DIR from .env');
  assert.ok(!fs.existsSync(path.join(dir, 'state')) && !fs.existsSync(path.join(dir, 'logs')), 'default folders unused');
  const pid = fs.readFileSync(path.join(st, 'bridge.pid'), 'utf8').trim();
  r = sh('start.sh');
  assert.match(r.stdout, new RegExp(`already running \\(pid ${pid}\\)`));
  r = sh('status.sh');
  assert.match(r.stdout, new RegExp(`running \\(pid ${pid}\\)`)); assert.match(r.stdout, /status: +RUNNING/);
  assert.strictEqual(sh('healthcheck.sh').status, 0);

  // watchdog: a second copy exits at once
  const wd = spawn('bash', [path.join(dir, 'watchdog.sh')], { env: shEnv, stdio: 'ignore' });
  t.after(() => { try { wd.kill('SIGTERM'); } catch { /* ignore */ } });
  await waitFor(() => fs.existsSync(path.join(st, 'watchdog.pid')));
  r = sh('watchdog.sh');
  assert.match(r.stdout, /watchdog already running/);
  wd.kill('SIGTERM');
  await waitFor(() => !fs.existsSync(path.join(st, 'watchdog.pid')));

  r = sh('stop.sh');
  assert.match(r.stdout, new RegExp(`stopped \\(pid ${pid}\\)`));
  assert.strictEqual(fs.readFileSync(path.join(st, 'STATUS'), 'utf8').trim(), 'STOPPED');

  // PID reuse: the pid file names an unrelated live process; stop must not kill it and start must start
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { try { other.kill('SIGKILL'); } catch { /* ignore */ } });
  fs.writeFileSync(path.join(st, 'bridge.pid'), `${other.pid}\n`);
  r = sh('stop.sh');
  assert.match(r.stdout, /not running/);
  assert.doesNotThrow(() => process.kill(other.pid, 0), 'unrelated process still alive');
  fs.writeFileSync(path.join(st, 'bridge.pid'), `${other.pid}\n`);
  r = sh('start.sh');
  assert.match(r.stdout, /started \(pid \d+, status RUNNING\)/, r.stdout + r.stderr);
  r = sh('stop.sh');
  assert.match(r.stdout, /stopped/);
});

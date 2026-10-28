#!/usr/bin/env node
'use strict';
// Send a plain-text reply, an image, a voice clip or a file to a QQ user via the bot.
// Recommended (no shell quoting problems): ./reply.sh --to <openid> --stdin <<'EOF_REPLY' ... EOF_REPLY
// Prints "OK" (exit 0) or "ERROR <code>" (exit non-zero). Exit codes: 1 generic, 2 usage / configuration,
// 3 REPLY_WINDOW (the user has to write again first), 15 BANNED, 16 BAD_CREDENTIALS, 17 IP_WHITELIST.
const path = require('node:path');
const C = require('../src/config');
const F = require('../src/files');
const Q = require('../src/qq');
const { sendReply, sendMedia, loadImage, loadVoice, loadFile } = require('../src/reply');
const { recipientProblem, checkSendablePath } = require('../src/outbound');

const MEDIA_FLAGS = { '--image': 'image', '--voice': 'voice', '--file': 'file' };
const LOADERS = { image: loadImage, voice: loadVoice, file: loadFile };

const USAGE = `Usage: ./reply.sh --to <openid> --stdin <<'EOF'      (recommended: text on stdin)
       ./reply.sh --to <openid> [--] "plain text"
       ./reply.sh --to <openid> --image <file.png|jpg|gif> [--stdin | -- "caption"]
       ./reply.sh --to <openid> --voice <file.silk|wav|mp3> [--stdin | -- "caption"]
       ./reply.sh --to <openid> --file <any file> [--stdin | -- "caption"]
Options: --to <openid>   recipient (required): the payload's sender_id, or "owner" for the bound owner
         --stdin         read the text (or the caption) from stdin; use a quoted heredoc (<<'EOF')
         --image/--voice/--file <file>  send media (one per call)
         --              end of options (text may then start with '-')
         -h, --help      show this help
Text without --stdin or arguments is also read from stdin when stdin is not a terminal.
Prints OK (exit 0) or ERROR <code> (exit non-zero; usage errors exit 2, REPLY_WINDOW exits 3).`;

function parseArgs(argv) {
  const out = { to: '', image: '', rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') {
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('-')) { out.badTo = v === undefined ? '(missing)' : v === '' ? '(empty)' : v; break; }
      out.to = v; i++;
    } else if (MEDIA_FLAGS[a]) {
      const kind = MEDIA_FLAGS[a];
      if (out.kind && out.kind !== kind) out.conflict = true;
      out.kind = kind; out[kind] = argv[++i] || '';
    } else if (a === '--stdin') out.stdin = true;
    else if (a === '-h' || a === '--help') { out.help = true; break; }
    else if (a === '--') { out.rest.push(...argv.slice(i + 1)); break; }
    else if (a.startsWith('-') && a !== '-') { out.unknown = a; break; }
    else out.rest.push(a);
  }
  if (!out.kind) delete out.kind; // keeps the plain-text shape { to, image, rest }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }
  const usage = (detail) => { console.log(`ERROR USAGE${detail ? ' ' + detail : ''}`); console.error(USAGE); process.exit(2); };
  if (args.unknown) usage(`unknown option ${args.unknown}`);
  if (args.conflict) { console.log('ERROR USAGE'); console.error('use only one of --image, --voice, --file per call'); process.exit(2); }
  if (args.badTo) usage(`--to needs a recipient id, got ${args.badTo}`);
  if (args.to && args.to !== 'owner' && recipientProblem(args.to)) usage(`invalid --to: ${recipientProblem(args.to)}`);
  if (args.stdin && args.rest.length) usage('use either --stdin or text arguments, not both');
  let cfg;
  try { cfg = C.loadConfig({ requireWebhook: false }); } catch (e) { console.log('ERROR CONFIG'); console.error(e.message); process.exit(2); }
  const P = C.paths(cfg);
  const log = F.makeLogger(P.log);
  const fail = (label, exit, detail) => { console.log(`ERROR ${label}`); if (detail) console.error(detail); log(`reply ERROR ${label}`); process.exit(exit); };

  let raw = ''; let mediaPath = ''; let caption = args.rest.join(' ');
  if (args.kind) {
    if (!args[args.kind]) fail('NO_FILE', 1, `usage: ./reply.sh --to <openid> --${args.kind} <file> [--stdin | -- "caption"]`);
    mediaPath = path.resolve(process.env.REPLY_CWD || process.cwd(), args[args.kind]);
    try {
      LOADERS[args.kind](mediaPath); // validate before any network call
      checkSendablePath(mediaPath, { root: C.ROOT, stateDir: cfg.stateDir, mediaDir: cfg.mediaDir, allowedDirs: cfg.replyAllowedDirs });
    } catch (e) { fail(e.label || 'BAD_FILE', 1, e.message); }
    if (args.stdin) caption = await readStdin();
  } else {
    if (args.rest.length) raw = args.rest.join(' ');
    else if (args.stdin || !process.stdin.isTTY) raw = await readStdin();
    if (!raw || !raw.trim()) fail('EMPTY_TEXT', 1, 'usage: ./reply.sh --to <openid> --stdin <<\'EOF\' ... (or text after --)');
  }
  if (!args.to) fail('NO_RECIPIENT', 2, '--to is required: pass the payload\'s sender_id (or "owner" for the bound owner)');
  const to = args.to === 'owner' ? (cfg.ownerId || C.ownerStore(P).get()) : args.to;
  if (!to) fail('NO_RECIPIENT', 1, 'no owner is bound yet: send the bot a message first, set OWNER_ID, or pass --to <openid>');
  if (recipientProblem(to)) fail('NO_RECIPIENT', 1, `stored owner id is invalid: ${recipientProblem(to)}`);
  const store = C.fileStore(P);
  const tokens = new Q.TokenManager({ appId: cfg.appId, secret: cfg.appSecret });
  try {
    // One reply at a time per bridge, so concurrent calls never reuse a msg_seq or miscount the passive quota.
    await F.withFileLock(P.replyLock, async () => {
      if (mediaPath) {
        const r = await sendMedia(args.kind, mediaPath, caption, { to, tokens, store, apiBase: cfg.apiBase, logFn: log });
        log(`reply ${args.kind} OK ${r.kind} ${r.size}B passive=${r.passive} active=${r.active}`);
      } else {
        const r = await sendReply(raw, { to, tokens, store, apiBase: cfg.apiBase, logFn: log });
        log(`reply OK parts=${r.parts} passive=${r.passive} active=${r.active}`);
      }
    });
    console.log('OK');
  } catch (e) {
    const f = Q.fatalOf(e);
    const where = e.totalParts ? `sent ${e.sentParts}/${e.totalParts}` : e.stage ? `${args.kind || 'media'} ${e.stage}` : '';
    if (f) { F.writeSecure(P.status, f.status + '\n'); fail(e.label, f.exit, `${f.status}: ${C.FATAL_STATUS[f.status]} ${where}`.trim()); }
    if (e.replyWindow) {
      fail('REPLY_WINDOW', 3, `the passive reply window (60 min, 4 replies per message) is used up and QQ refused an active message (code ${e.label}); `
        + `the user has to send a new message first ${where}`.trim());
    }
    if (e instanceof Q.QQError) fail(e.label, 1, `${where}${e.platformMessage ? ' ' + Q.preview(e.platformMessage, 80) : ''}`.trim());
    fail(e.label || 'INTERNAL', 1, e.message);
  }
}

module.exports = { parseArgs, USAGE };
if (require.main === module) main().catch((e) => { console.log('ERROR INTERNAL'); console.error(e.message); process.exit(1); });

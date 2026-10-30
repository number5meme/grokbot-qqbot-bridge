#!/usr/bin/env node
'use strict';
// Record a relayed inbound message in the bridge's state (last-msgs.json / last-sender.json), exactly as the
// WebSocket bridge does on receipt, so reply.sh can answer it as a passive reply (inside QQ's reply window).
// Usage: node relay/note-inbound.cjs --sender <sender_id> --message-id <message_id> [--received-at <ISO time>]
const path = require('node:path');
const root = path.join(__dirname, '..');
const C = require(path.join(root, 'src/config'));
const F = require(path.join(root, 'src/files'));

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; }

const sender = arg('sender'); const messageId = arg('message-id'); const at = arg('received-at');
if (!sender || !messageId || !/^[A-Za-z0-9_.:-]{1,200}$/.test(sender) || !/^[A-Za-z0-9_.:!-]{1,200}$/.test(messageId)) {
  console.error('usage: note-inbound.cjs --sender <sender_id> --message-id <message_id> [--received-at <ISO time>]');
  process.exit(2);
}
let ms = at ? Date.parse(at) : Date.now();
if (!Number.isFinite(ms) || ms > Date.now() + 60_000) ms = Date.now();
const cfg = C.loadConfig({ requireWebhook: false });
const P = C.paths(cfg);
F.ensureDir(cfg.stateDir);
const store = C.fileStore(P);
store.saveLastMsg(sender, { msg_id: messageId, received_ms: ms });
store.saveLastSender(sender);
console.log(`noted message for passive reply (age ${Math.round((Date.now() - ms) / 1000)}s)`);

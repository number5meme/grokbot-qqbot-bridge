#!/usr/bin/env node
'use strict';
// Download one attachment of a relayed QQ message onto this machine with the bridge's own media code
// (allowed hosts, size cap, SILK voice -> WAV, private file permissions, MEDIA_DIR from the parent .env).
// Usage: node relay/fetch-media.cjs --kind image|voice|video|file --url <url> [--filename <name>] [--content-type <type>]
// Prints one JSON media entry ({ kind, path, content_type, size, ... } or { ..., path: null, error }).
const path = require('node:path');
const root = path.join(__dirname, '..');
const C = require(path.join(root, 'src/config'));
const { createMediaStore } = require(path.join(root, 'src/media-store'));
const { fetchOne } = require(path.join(root, 'src/media'));

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const kind = arg('kind'); const url = arg('url');
  if (!['image', 'voice', 'video', 'file'].includes(kind) || !url) {
    console.error('usage: fetch-media.cjs --kind image|voice|video|file --url <url> [--filename <name>] [--content-type <type>]');
    process.exit(2);
  }
  const cfg = C.loadConfig({ requireWebhook: false });
  const store = createMediaStore({ dir: cfg.mediaDir, maxBytes: cfg.mediaMaxBytes, retentionDays: cfg.mediaRetentionDays, allowedHosts: cfg.mediaAllowedHosts });
  const defaults = { image: 'image/png', voice: 'voice', video: 'video/mp4', file: 'file' };
  const att = { url, filename: arg('filename'), content_type: arg('content-type') || defaults[kind] };
  const entry = await fetchOne({ kind, att }, { store });
  console.log(JSON.stringify(entry));
  process.exit(entry.error ? 1 : 0);
}
main().catch((e) => { console.error(`ERROR ${e.message}`); process.exit(1); });

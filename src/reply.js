'use strict';
// Sending replies to QQ users: plain text (passive reply first, active message as fallback), images, voice and files.
const fs = require('node:fs');
const path = require('node:path');
const Q = require('./qq');
const { stripMarkdown, buildChunks } = require('./text');
const { sniffMime } = require('./media-store');

const CHUNK = 1800;
const MAX_CHUNKS = 10;
const PASSIVE_WINDOW_MS = 60 * 60_000; // C2C passive reply window per current docs (60 min)
const PASSIVE_MAX = 4; // max passive replies per inbound message
const PASSIVE_EXPIRED = [304103, 40034005, 40034128, 304027, 304026, 40034024];
const URL_BLOCKED = [304003];
const SEQ_DUP = [40054005];
// Active (non-reply) message refused: QQ stopped offering active push on 2025-04-21, the user may block active
// messages, and active quotas are small. Reported as REPLY_WINDOW (the user has to write again first).
const ACTIVE_REFUSED = [40034100, 40034105, 40054013];

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // ~10MB (platform hard limit is 20MB; base64 adds 33%)
const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // same single base64 upload limit for voice and files (no chunked upload here)
const FILE_TYPE = { image: 1, video: 2, voice: 3, file: 4 }; // POST /v2/users/{openid}/files file_type
// Voice formats uploaded as-is, as in the official SDK (@tencent-connect/qqbot-nodejs QQ_NATIVE_UPLOAD_FORMATS).
const VOICE_TYPES = { 'audio/silk': 'silk', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };
const UPLOAD_TIMEOUT_MS = 120_000;
const CAPTION_MAX = 1800;

function labeled(label, msg = label) { const e = new Error(msg); e.label = label; return e; }

/** Detect png/jpg/gif by magic bytes. Returns 'png' | 'jpg' | 'gif' | null. */
function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'gif';
  return null;
}

/** Read + validate a local image. Throws Error with .label FILE_NOT_FOUND / NOT_A_FILE / EMPTY_FILE / FILE_TOO_LARGE / UNSUPPORTED_TYPE. */
function loadImage(filePath, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  let st;
  try { st = fs.statSync(filePath); } catch { throw labeled('FILE_NOT_FOUND', `file not found: ${filePath}`); }
  if (!st.isFile()) throw labeled('NOT_A_FILE', `not a regular file: ${filePath}`);
  if (st.size === 0) throw labeled('EMPTY_FILE', `file is empty: ${filePath}`);
  if (st.size > maxBytes) throw labeled('FILE_TOO_LARGE', `file is ${(st.size / 1048576).toFixed(1)}MB; limit is ${(maxBytes / 1048576).toFixed(0)}MB`);
  const buf = fs.readFileSync(filePath);
  const kind = sniffImage(buf);
  if (!kind) throw labeled('UNSUPPORTED_TYPE', 'only png / jpg / gif images are supported');
  return { buf, kind, size: buf.length };
}

/** Common checks for any local file. */
function statFile(filePath, maxBytes) {
  let st;
  try { st = fs.statSync(filePath); } catch { throw labeled('FILE_NOT_FOUND', `file not found: ${filePath}`); }
  if (!st.isFile()) throw labeled('NOT_A_FILE', `not a regular file: ${filePath}`);
  if (st.size === 0) throw labeled('EMPTY_FILE', `file is empty: ${filePath}`);
  if (st.size > maxBytes) throw labeled('FILE_TOO_LARGE', `file is ${(st.size / 1048576).toFixed(1)}MB; limit is ${(maxBytes / 1048576).toFixed(0)}MB`);
  return st;
}

/** Read + validate a voice clip: SILK, WAV or MP3 (detected by content, not by extension). */
function loadVoice(filePath, { maxBytes = MAX_MEDIA_BYTES } = {}) {
  statFile(filePath, maxBytes);
  const buf = fs.readFileSync(filePath);
  const kind = VOICE_TYPES[sniffMime(buf)];
  if (!kind) throw labeled('UNSUPPORTED_TYPE', 'voice must be a .silk, .wav or .mp3 file');
  return { buf, kind, size: buf.length };
}

/** Read + validate any file for a file message. file_name = the base name (control characters removed). */
function loadFile(filePath, { maxBytes = MAX_MEDIA_BYTES } = {}) {
  statFile(filePath, maxBytes);
  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath).replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 200) || 'file';
  return { buf, kind: 'file', size: buf.length, name };
}

/** Passive-reply bookkeeping (persisted per msg_id): { [msg_id]: { seq, count, dead } }. Shared by text and image sends. */
function passiveBook(store, to, now) {
  const seqs = store.getSeq() || {};
  const last = store.getLastMsg(to);
  const lastId = last && last.msg_id ? last.msg_id : null;
  const book = lastId ? (seqs[lastId] || { seq: 0, count: 0, dead: false }) : null;
  const persist = () => {
    if (!lastId) return;
    const all = store.getSeq() || {};
    delete all[lastId]; all[lastId] = book;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete all[k]; // keep recent msg_ids only
    store.saveSeq(all);
  };
  const passiveUsable = () => Boolean(book && !book.dead && book.count < PASSIVE_MAX
    && Number.isFinite(last.received_ms) && now() - last.received_ms < PASSIVE_WINDOW_MS);
  return { lastId, book, persist, passiveUsable };
}

/**
 * Core send logic, exported for tests. Sends all chunks; returns { ok:true, passive, active } or throws QQError / Error(code).
 * deps: { tokens (TokenManager-like), store, fetchImpl, now, logFn }
 */
async function sendReply(raw, { to, tokens, store, fetchImpl = fetch, now = Date.now, logFn = () => {}, apiBase = Q.API_BASE }) {
  if (!to) throw labeled('NO_RECIPIENT');
  const parts = buildChunks(raw, { chunkSize: CHUNK, maxChunks: MAX_CHUNKS });
  if (!parts.length) throw labeled('EMPTY_TEXT');
  const path = `/v2/users/${encodeURIComponent(to)}/messages`;
  const stats = { passive: 0, active: 0 };

  const { lastId, book, persist, passiveUsable } = passiveBook(store, to, now);

  for (let i = 0; i < parts.length; i++) {
    let content = parts[i];
    let authRetried = false; let urlRetried = false; let dupRetried = false;
    for (let guard = 0; guard < 8; guard++) {
      const passive = passiveUsable();
      const body = { content, msg_type: 0 };
      if (passive) { book.seq += 1; body.msg_id = lastId; body.msg_seq = book.seq; persist(); }
      try {
        const token = await tokens.get();
        await Q.apiRequest({ method: 'POST', path, body, token, fetchImpl, base: apiBase });
        if (passive) { book.count += 1; persist(); stats.passive++; } else stats.active++;
        break;
      } catch (e) {
        if (!(e instanceof Q.QQError)) throw e;
        if (Q.fatalOf(e)) throw e;
        if (Q.isAuthError(e) && !authRetried) { authRetried = true; tokens.invalidate(); logFn(`reply auth error ${e.label}, refreshing token`); continue; }
        if (passive && e.has(...PASSIVE_EXPIRED)) { book.dead = true; persist(); logFn(`reply passive window closed (${e.label}), falling back to active`); continue; }
        if (passive && e.has(...SEQ_DUP) && !dupRetried) { dupRetried = true; logFn('reply msg_seq dedup, bumping seq'); continue; }
        if (e.has(...URL_BLOCKED) && !urlRetried) { urlRetried = true; content = Q.stripUrls(content); logFn('reply URL not allowed (304003), retrying without URLs'); continue; }
        if (!passive && e.has(...ACTIVE_REFUSED)) e.replyWindow = true;
        e.sentParts = i; e.totalParts = parts.length;
        throw e;
      }
    }
  }
  return { ok: true, parts: parts.length, ...stats };
}

/**
 * Send one image, voice clip or file to a user, optionally with a caption.
 * Step 1: POST /v2/users/{openid}/files {file_type, srv_send_msg:false, file_data:<base64>[, file_name]} -> file_info
 *         (base64 upload, as in Tencent's official @tencent-connect/qqbot-nodejs MediaApi.uploadMedia; no public URL needed).
 *         file_type: 1 image, 3 voice, 4 file (file_name only for files).
 * Step 2: POST /v2/users/{openid}/messages {msg_type:7, media:{file_info}, content, msg_id, msg_seq} (passive), else active.
 *         Images always carry content (" " without a caption, as before); voice and files only when a caption is given
 *         (the official SDK omits an empty content).
 * file_data is never logged.
 */
async function sendMedia(kind, filePath, caption, { to, tokens, store, fetchImpl = fetch, now = Date.now, logFn = () => {}, apiBase = Q.API_BASE, maxBytes }) {
  if (!to) throw labeled('NO_RECIPIENT');
  if (!FILE_TYPE[kind] || kind === 'video') throw labeled('UNSUPPORTED_KIND');
  const media = kind === 'image' ? loadImage(filePath, { maxBytes: maxBytes || MAX_IMAGE_BYTES })
    : kind === 'voice' ? loadVoice(filePath, { maxBytes: maxBytes || MAX_MEDIA_BYTES }) : loadFile(filePath, { maxBytes: maxBytes || MAX_MEDIA_BYTES });
  const base = `/v2/users/${encodeURIComponent(to)}`;

  // 1) upload
  let fileInfo; let authRetried = false;
  const uploadBody = { file_type: FILE_TYPE[kind], srv_send_msg: false, file_data: media.buf.toString('base64') };
  if (kind === 'file') uploadBody.file_name = media.name;
  for (;;) {
    try {
      const token = await tokens.get();
      const res = await Q.apiRequest({ method: 'POST', path: `${base}/files`, token, fetchImpl, base: apiBase, timeoutMs: UPLOAD_TIMEOUT_MS, body: uploadBody });
      fileInfo = res && res.file_info;
      if (!fileInfo) throw labeled('UPLOAD_NO_FILE_INFO', 'upload response had no file_info');
      break;
    } catch (e) {
      if (!(e instanceof Q.QQError)) throw e;
      if (Q.fatalOf(e)) throw e;
      if (Q.isAuthError(e) && !authRetried) { authRetried = true; tokens.invalidate(); logFn(`${kind} upload auth error ${e.label}, refreshing token`); continue; }
      e.stage = 'upload';
      throw e;
    }
  }
  logFn(`${kind} uploaded ${media.kind} ${media.size}B`);

  // 2) send media message (passive first, then active)
  const cap = stripMarkdown(caption || '').slice(0, CAPTION_MAX);
  let content = kind === 'image' ? (cap || ' ') : cap;
  const { lastId, book, persist, passiveUsable } = passiveBook(store, to, now);
  let authRetried2 = false; let urlRetried = false; let dupRetried = false;
  for (let guard = 0; guard < 8; guard++) {
    const passive = passiveUsable();
    const body = { msg_type: 7, media: { file_info: fileInfo } };
    if (content) body.content = content;
    if (passive) { book.seq += 1; body.msg_id = lastId; body.msg_seq = book.seq; persist(); }
    try {
      const token = await tokens.get();
      await Q.apiRequest({ method: 'POST', path: `${base}/messages`, body, token, fetchImpl, base: apiBase });
      if (passive) { book.count += 1; persist(); }
      return { ok: true, kind: media.kind, size: media.size, passive: passive ? 1 : 0, active: passive ? 0 : 1 };
    } catch (e) {
      if (!(e instanceof Q.QQError)) throw e;
      if (Q.fatalOf(e)) throw e;
      if (Q.isAuthError(e) && !authRetried2) { authRetried2 = true; tokens.invalidate(); logFn(`${kind} send auth error ${e.label}, refreshing token`); continue; }
      if (passive && e.has(...PASSIVE_EXPIRED)) { book.dead = true; persist(); logFn(`${kind} passive window closed (${e.label}), falling back to active`); continue; }
      if (passive && e.has(...SEQ_DUP) && !dupRetried) { dupRetried = true; logFn(`${kind} msg_seq dedup, bumping seq`); continue; }
      if (content && e.has(...URL_BLOCKED) && !urlRetried) { urlRetried = true; content = Q.stripUrls(content); logFn(`${kind} caption URL not allowed (304003), retrying without URLs`); continue; }
      if (!passive && e.has(...ACTIVE_REFUSED)) e.replyWindow = true;
      e.stage = 'send';
      throw e;
    }
  }
  throw labeled('RETRY_EXHAUSTED');
}

/** Send one image (png/jpg/gif, <= ~10MB). Kept for compatibility: sendMedia('image', ...). */
function sendImage(filePath, caption, deps) { return sendMedia('image', filePath, caption, deps); }
function sendVoice(filePath, caption, deps) { return sendMedia('voice', filePath, caption, deps); }
function sendFile(filePath, caption, deps) { return sendMedia('file', filePath, caption, deps); }

module.exports = { sendReply, sendMedia, sendImage, sendVoice, sendFile, loadImage, loadVoice, loadFile, sniffImage, CHUNK, MAX_CHUNKS,
  PASSIVE_WINDOW_MS, PASSIVE_MAX, MAX_IMAGE_BYTES, MAX_MEDIA_BYTES, FILE_TYPE, ACTIVE_REFUSED };

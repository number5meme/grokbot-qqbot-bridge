'use strict';
// Inbound QQ C2C attachments -> local files. Follows Tencent's official QQ bot plugin
// (@tencent-connect/openclaw-qqbot, src/middleware/attachment.ts) and SDK (@tencent-connect/qqbot-nodejs):
//  - attachments[] carry url, filename, content_type (image/*, video/mp4, voice, file ...), size, width, height;
//  - "//host/..." URLs are completed to https; only https URLs on allowed hosts (MEDIA_ALLOWED_HOSTS) are downloaded;
//  - voice: asr_refer_text (QQ's built-in speech recognition) is the transcript when present; the audio is
//    downloaded from voice_wav_url (WAV) when present, else from url (SILK, transcoded to WAV with silk-wasm when
//    available, else kept as .silk).
// Download failures never drop the message: the entry is kept with path null and an error label.
const path = require('node:path');
const { fetchLimited, sniffMime, mimeFromFilename } = require('./media-store');
const { silkToWav } = require('./silk');

const MAX_MEDIA_PER_MESSAGE = 10;

function normalizeUrl(u) {
  if (!u || typeof u !== 'string') return '';
  const s = u.trim();
  return s.startsWith('//') ? `https:${s}` : s;
}

/** Same rule as the official SDK's isVoiceAttachment. */
function isVoice(att) {
  const ct = String(att.content_type || '').toLowerCase();
  if (ct === 'voice' || ct.startsWith('audio/')) return true;
  return ['.amr', '.silk', '.slk', '.slac'].includes(path.extname(String(att.filename || '')).toLowerCase());
}
function kindOf(att) {
  if (isVoice(att)) return 'voice';
  const ct = String(att.content_type || '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  return 'file';
}

/** Attachments worth reporting: [{ kind, att, transcript? }]. Entries without a URL or transcript are ignored. */
function collectAttachments(d) {
  const out = [];
  for (const att of Array.isArray(d && d.attachments) ? d.attachments : []) {
    if (!att || typeof att !== 'object') continue;
    const kind = kindOf(att);
    const transcript = kind === 'voice' && typeof att.asr_refer_text === 'string' ? att.asr_refer_text.trim() : '';
    const url = normalizeUrl(att.url) || (kind === 'voice' ? normalizeUrl(att.voice_wav_url) : '');
    if (!url && !transcript) continue;
    out.push({ kind, att, transcript });
  }
  return out.slice(0, MAX_MEDIA_PER_MESSAGE);
}

function cleanName(att) { return att.filename ? String(att.filename).slice(0, 200) : undefined; }

async function fetchOne(c, { store, fetchImpl, transcode = silkToWav }) {
  const { att, kind } = c;
  const base = { kind };
  if (c.transcript) base.transcript = c.transcript;
  const declared = Number(att.size);
  try {
    if (Number.isFinite(declared) && declared > store.maxBytes) { const e = new Error('too large'); e.label = 'TOO_LARGE'; throw e; }
    const opts = { fetchImpl, maxBytes: store.maxBytes, allowedHosts: store.allowedHosts };
    if (kind === 'voice') {
      const wavUrl = normalizeUrl(att.voice_wav_url);
      if (!wavUrl && !normalizeUrl(att.url)) return { ...base, path: null, content_type: null, size: null }; // transcript only
      if (wavUrl) {
        const wav = await fetchLimited(wavUrl, opts);
        return { ...base, ...store.save(wav, { kind: 'voice', contentType: 'audio/wav' }) };
      }
      const raw = await fetchLimited(normalizeUrl(att.url), opts);
      const sniffed = sniffMime(raw);
      if (sniffed === 'audio/silk' || sniffed === 'audio/amr') {
        const wav = await transcode(raw);
        if (wav) return { ...base, ...store.save(wav, { kind: 'voice', contentType: 'audio/wav' }) };
      }
      return { ...base, ...store.save(raw, { kind: 'voice', contentType: sniffed || 'audio/silk' }) };
    }
    const buf = await fetchLimited(normalizeUrl(att.url), opts);
    const filename = kind === 'file' ? cleanName(att) : undefined;
    let ct = String(att.content_type || '').toLowerCase();
    if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(ct)) ct = sniffMime(buf) || (filename ? mimeFromFilename(filename) : 'application/octet-stream');
    const e = { ...base, ...store.save(buf, { kind, contentType: ct, filename }) };
    if (kind === 'image' && Number(att.width) > 0 && Number(att.height) > 0) { e.width = Number(att.width); e.height = Number(att.height); }
    return e;
  } catch (err) {
    const e = { ...base, path: null, content_type: null, size: null, error: err.label || 'DOWNLOAD_FAILED' };
    const n = kind === 'file' ? cleanName(att) : undefined;
    if (n) e.filename = n;
    return e;
  }
}

/** Download every collected attachment (sequentially, to bound memory). */
async function fetchMedia(collected, deps) {
  const out = [];
  for (const c of collected) out.push(await fetchOne(c, deps));
  return out;
}

module.exports = { collectAttachments, fetchOne, fetchMedia, normalizeUrl, isVoice, kindOf, MAX_MEDIA_PER_MESSAGE };

'use strict';
// QQ Bot Open Platform (API v2) client pieces: access tokens, OpenAPI requests, and error mapping.
// Outbound HTTPS only. Never log AppID, AppSecret, access tokens, or the webhook URL/key.

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
const USER_AGENT = 'grokbot-qqbot-bridge/1.0';
const INTENT_GROUP_AND_C2C = 1 << 25;

// Fatal conditions -> STATUS value + process exit code. Supervisors must not restart on these.
const FATAL = {
  BANNED: { status: 'BANNED', exit: 15 },
  BAD_CREDENTIALS: { status: 'BAD_CREDENTIALS', exit: 16 },
  IP_WHITELIST: { status: 'IP_WHITELIST', exit: 17 },
  INTENT_DENIED: { status: 'INTENT_DENIED', exit: 18 },
};
const AUTH_CODES = new Set([11201, 11241, 11242, 11243, 40012001]); // token missing / invalid / expired

function preview(text, n = 40) { const t = String(text).replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n) + '...' : t; }

/** Error from the QQ platform. codes = all numeric codes seen (code, err_code); http = HTTP status (0 = network). */
class QQError extends Error {
  constructor({ http = 0, code, errCode, message = '', where = '' }) {
    const primary = code ?? errCode;
    super(`${where} ${primary !== undefined ? 'code=' + primary : 'HTTP ' + http}`.trim());
    this.http = http; this.code = code; this.errCode = errCode; this.where = where; this.platformMessage = String(message).slice(0, 120);
    this.codes = [code, errCode].filter((c) => typeof c === 'number');
  }
  has(...cs) { return cs.some((c) => this.codes.includes(c)); }
  /** Short label for "ERROR <label>" output. */
  get label() { return this.codes.length ? String(this.codes[0]) : this.http ? `HTTP_${this.http}` : 'NETWORK'; }
}

/** Map an error to a FATAL entry (or null). */
function fatalOf(err) {
  if (!(err instanceof QQError)) return null;
  if (err.has(11298)) return FATAL.IP_WHITELIST;
  if (err.has(100016, 100007, 10004, 11251, 11261, 11275)) return FATAL.BAD_CREDENTIALS;
  if (err.has(11265)) return FATAL.BANNED;
  return null;
}
function isAuthError(err) { return err instanceof QQError && (err.http === 401 || err.codes.some((c) => AUTH_CODES.has(c))); }

function parseBody(text) { if (!text || !text.trim()) return {}; try { return JSON.parse(text); } catch { return { _raw: true }; } }
function num(v) { if (v === undefined || v === null || v === '') return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; }

const TOKEN_TIMEOUT_MS = 15_000;

/**
 * fetch + body read under one timeout (a body that stalls after the headers, e.g. a socket that died while the
 * host slept, must not hang forever). An optional caller signal (stop, or a wake-up forcing a fresh attempt)
 * aborts too. Returns { res, text }.
 */
async function timedFetch(fetchImpl, url, opts, timeoutMs, signal) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    // Raced against the signal too, so even a fetch implementation that ignores the signal cannot hang the caller.
    const aborted = new Promise((resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (ctrl.signal.aborted) fail(); else ctrl.signal.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => {});
    const res = await Promise.race([fetchImpl(url, { ...opts, signal: ctrl.signal }), aborted]);
    const text = await Promise.race([Promise.resolve().then(() => res.text()).catch(() => ''), aborted]);
    return { res, text };
  } finally { clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort); }
}

/**
 * Access-token manager. Token kept in memory only. Refreshes ~5 min before expiry
 * (or at 1/3 of remaining lifetime for short tokens). expires_in arrives as a string.
 */
class TokenManager {
  constructor({ appId, secret, fetchImpl = fetch, now = Date.now, tokenUrl = TOKEN_URL }) {
    if (!appId || !secret) throw new Error('missing app credentials');
    this.appId = String(appId).trim(); this.secret = String(secret).trim();
    this.fetchImpl = fetchImpl; this.now = now; this.tokenUrl = tokenUrl;
    this.token = null; this.expiresAt = 0; this.ttlMs = 0; this.pending = null;
  }
  invalidate() { this.token = null; this.expiresAt = 0; }
  needsRefresh() {
    if (!this.token) return true;
    const remaining = this.expiresAt - this.now();
    return remaining <= Math.min(5 * 60_000, this.ttlMs / 3); // ~5 min early (1/3 of lifetime for short tokens)
  }
  async get({ force = false, signal } = {}) {
    if (force) this.invalidate();
    if (!this.needsRefresh()) return this.token;
    if (!this.pending) this.pending = this.fetchToken(signal).finally(() => { this.pending = null; });
    return this.pending;
  }
  async fetchToken(signal) {
    let res, text;
    try {
      ({ res, text } = await timedFetch(this.fetchImpl, this.tokenUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }),
      }, TOKEN_TIMEOUT_MS, signal));
    } catch (e) { throw new QQError({ where: 'token', message: e.name === 'AbortError' ? 'timeout' : 'network' }); }
    const body = parseBody(text);
    if (!res.ok || !body.access_token) {
      throw new QQError({ http: res.status, code: num(body.code), errCode: num(body.err_code), message: body.message, where: 'token' });
    }
    const ttl = num(body.expires_in) ?? 7200;
    this.token = body.access_token;
    this.ttlMs = ttl * 1000;
    this.expiresAt = this.now() + this.ttlMs;
    return this.token;
  }
}

/** Call the OpenAPI. Throws QQError on non-2xx. */
async function apiRequest({ method, path: p, body, token, fetchImpl = fetch, base = API_BASE, timeoutMs = 15_000, signal }) {
  let res, text;
  try {
    ({ res, text } = await timedFetch(fetchImpl, base + p, {
      method,
      headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, timeoutMs, signal));
  } catch (e) { throw new QQError({ where: method + ' ' + p.split('/').slice(0, 3).join('/'), message: e.name === 'AbortError' ? 'timeout' : 'network' }); }
  const data = parseBody(text);
  if (!res.ok) throw new QQError({ http: res.status, code: num(data.code), errCode: num(data.err_code), message: data.message, where: method });
  // Some failures come back 200 with a code (e.g. code != 0 and no id)
  if (data && num(data.code) && !data.id && !data.url) throw new QQError({ http: res.status, code: num(data.code), errCode: num(data.err_code), message: data.message, where: method });
  return data;
}


/** Replace URLs with a neutral placeholder (used after error 304003 URL_NOT_ALLOWED). */
const URL_STOP = '\\s<>"\'\\)\\uff09\\u3011'; // whitespace, quotes, brackets, full-width ")" and closing lenticular bracket
function stripUrls(text) {
  const tail = `[^${URL_STOP}]`;
  return String(text)
    .replace(new RegExp(`\\b(?:https?|ftp):\\/\\/${tail}+`, 'gi'), '[link removed]')
    .replace(new RegExp(`\\bwww\\.${tail}+`, 'gi'), '[link removed]')
    .replace(new RegExp(`\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:com|cn|net|org|io|ai|me|dev|app|co|xyz|top|info|gov|edu)(?:\\/${tail}*)?`, 'gi'), '[link removed]');
}

module.exports = {
  TOKEN_URL, API_BASE, USER_AGENT, INTENT_GROUP_AND_C2C, FATAL, AUTH_CODES,
  QQError, fatalOf, isAuthError, TokenManager, apiRequest, timedFetch, stripUrls, preview, parseBody, num,
};

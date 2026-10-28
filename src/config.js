'use strict';
// QQ bridge configuration and on-disk state layout.
const path = require('node:path');
const { loadDotEnv } = require('./env');
const { ConfigError, parseCommon, hostAllowed } = require('./config-common');
const F = require('./files');
const Q = require('./qq');

const ROOT = path.join(__dirname, '..');

// STATUS values that need a human. Supervisors must not restart on these.
const FATAL_STATUS = {
  BAD_CREDENTIALS: 'AppID or AppSecret rejected (100016 / 100007 ...). The AppSecret is reset whenever it is viewed again on q.qq.com; update QQBOT_APP_SECRET, then ./start.sh',
  IP_WHITELIST: 'request blocked by the IP whitelist (11298). Clear the server IP whitelist on q.qq.com (or add this host\'s egress IP), then ./start.sh',
  BANNED: 'bot delisted or banned (close code 4914/4915). Check the bot status on q.qq.com',
  INTENT_DENIED: 'missing permission for C2C/group message events (close code 4013/4014). Check the bot capabilities on q.qq.com',
  CONFIG_ERROR: 'configuration is invalid. Fix .env (see .env.example), then ./start.sh',
};
const EXIT = { OK: 0, CRASH: 1, CONFIG: 2 };

function loadConfig({ env = process.env, root = ROOT, requireWebhook = true, requireApp = true, dotenv = true } = {}) {
  if (dotenv && env.BRIDGE_NO_DOTENV !== '1') loadDotEnv(path.join(root, '.env'), env);
  const { cfg, errors } = parseCommon(env, { root, requireWebhook });
  cfg.appId = (env.QQBOT_APP_ID || '').trim();
  cfg.appSecret = (env.QQBOT_APP_SECRET || '').trim();
  if (requireApp) {
    if (!cfg.appId) errors.push('QQBOT_APP_ID is required (bot AppID from q.qq.com)');
    else if (!/^\d+$/.test(cfg.appId)) errors.push('QQBOT_APP_ID must be numeric');
    if (!cfg.appSecret) errors.push('QQBOT_APP_SECRET is required (bot AppSecret from q.qq.com)');
  }
  cfg.apiBase = (env.QQBOT_API_BASE || Q.API_BASE).replace(/\/+$/, '');
  let apiHost = '';
  try { const u = new URL(cfg.apiBase); apiHost = u.protocol === 'https:' ? u.hostname : ''; } catch { /* invalid */ }
  if (!apiHost) errors.push('QQBOT_API_BASE must be an https URL');
  else if (!hostAllowed(apiHost, ['qq.com'])) errors.push('QQBOT_API_BASE must be a qq.com host (the access token is sent to it)');
  if (errors.length) throw new ConfigError(errors);
  return cfg;
}

function paths(cfg) {
  const s = (f) => path.join(cfg.stateDir, f);
  return {
    owner: s('owner.json'),
    lastMsgs: s('last-msgs.json'),
    lastSender: s('last-sender.json'),
    replySeq: s('reply-seq.json'),
    seen: s('seen.json'),
    session: s('session.json'),
    stats: s('stats.json'),
    status: s('STATUS'),
    heartbeat: s('HEARTBEAT'),
    health: s('health.json'),
    pid: s('bridge.pid'),
    undelivered: s('undelivered.jsonl'),
    replyLock: s('reply.lock'),
    log: path.join(cfg.logDir, 'bridge.log'),
  };
}

const LAST_MSGS_MAX = 50;
const UNDELIVERED_MAX_BYTES = 50 * 1024 * 1024; // undelivered.jsonl is rotated to .1 at this size

function ownerStore(P) {
  return {
    get: () => { const o = F.readJson(P.owner, null); return (o && o.owner_id) || null; },
    set: (id) => F.writeJson(P.owner, { owner_id: id, bound_at: new Date().toISOString() }),
  };
}
function statsStore(P) { return { load: () => F.readJson(P.stats, null), save: (o) => F.writeJson(P.stats, o) }; }

/** File-backed store used by the bridge and reply commands (all files mode 600). */
function fileStore(P) {
  return {
    loadSeen: () => { const a = F.readJson(P.seen, []); return Array.isArray(a) ? a : []; },
    saveSeen: (arr) => F.writeJson(P.seen, arr),
    saveLastMsg: (openid, o) => {
      const all = F.readJson(P.lastMsgs, {}) || {};
      delete all[openid]; all[openid] = o;
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - LAST_MSGS_MAX))) delete all[k];
      F.writeJson(P.lastMsgs, all);
    },
    getLastMsg: (openid) => (F.readJson(P.lastMsgs, {}) || {})[openid] || null,
    saveLastSender: (openid) => F.writeJson(P.lastSender, { sender_id: openid, at: new Date().toISOString() }),
    getLastSender: () => { const o = F.readJson(P.lastSender, null); return (o && o.sender_id) || null; },
    appendUndelivered: (o) => F.appendSecure(P.undelivered, JSON.stringify(o) + '\n', { maxBytes: UNDELIVERED_MAX_BYTES }),
    loadSession: () => F.readJson(P.session, null),
    saveSession: (s) => F.writeJson(P.session, s),
    clearSession: () => F.writeJson(P.session, {}),
    getSeq: () => F.readJson(P.replySeq, {}) || {},
    saveSeq: (o) => F.writeJson(P.replySeq, o),
  };
}

module.exports = { ROOT, FATAL_STATUS, EXIT, ConfigError, loadConfig, paths, ownerStore, statsStore, fileStore, LAST_MSGS_MAX, UNDELIVERED_MAX_BYTES };

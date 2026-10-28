'use strict';
// C2C (one-to-one) message handling: dedupe, sender protection, reply bookkeeping, forwarding.
// Text = message content plus QQ's voice transcripts (asr_refer_text, prefixed "[voice] "). Attachments are
// downloaded only after the sender passed the guard, and listed in the payload's "media" array.
// The handler runs behind a serial queue (src/queue.js); salvage() turns an event that could not be finished
// before shutdown into an undelivered payload (flagged "interrupted": true), so nothing is silently lost.
const { buildPayload } = require('./guard');
const { collectAttachments } = require('./media');

const SEEN_MAX = 500;
const VOICE_PREFIX = '[voice] ';

function eventText(d, collected) {
  const content = typeof d.content === 'string' ? d.content.trim() : '';
  return [content, ...collected.filter((c) => c.transcript).map((c) => VOICE_PREFIX + c.transcript)].filter(Boolean).join('\n').trim();
}

/**
 * store: { loadSeen(), saveSeen(arr), saveLastMsg(openid, {msg_id, received_ms}), saveLastSender(openid), appendUndelivered(obj) }
 * fetchMedia(collected) -> entries; null disables media (voice transcripts are still forwarded as text).
 * Returns 'forwarded' | 'undelivered' | 'duplicate' | 'dropped' | 'rate_limited' | 'non_text' | 'invalid'.
 * 'non_text' means nothing to forward (no text and no usable attachment).
 */
function makeC2CHandler({ store, guard, forward, mirror = true, logFn = () => {}, now = Date.now, fetchMedia = null }) {
  const seenArr = (store.loadSeen() || []).slice(-SEEN_MAX);
  const seen = new Set(seenArr);
  const inflight = new Map(); // message id -> payload without media (written out if shutdown interrupts it)
  const remember = (id) => {
    seen.add(id); seenArr.push(id);
    while (seenArr.length > SEEN_MAX) seen.delete(seenArr.shift());
    store.saveSeen(seenArr);
  };
  const ids = (d) => ({ id: d && d.id ? String(d.id) : '', openid: d && d.author && d.author.user_openid ? String(d.author.user_openid) : '' });

  async function handleC2C(d) {
    const { id, openid } = ids(d);
    if (!id || !openid) { logFn('drop c2c event without id/openid'); return 'invalid'; }
    if (seen.has(id)) { logFn('skip duplicate message'); return 'duplicate'; }
    remember(id);

    const collected = collectAttachments(d);
    const text = eventText(d, collected);
    const decision = guard.check(openid, text);
    if (!decision.forward) return decision.reason === 'not_owner' ? 'dropped' : decision.reason;

    const receivedMs = now();
    store.saveLastMsg(openid, { msg_id: id, received_ms: receivedMs }); // enables passive replies to this message
    store.saveLastSender(openid);
    const toFetch = fetchMedia ? collected : [];
    if (!text && !toFetch.length) {
      const n = Array.isArray(d.attachments) ? d.attachments.length : 0;
      logFn(`message without text or usable attachments (type ${d.message_type}, ${n} attachments) not forwarded; reply window saved`);
      return 'non_text';
    }
    const base = { source: 'qq', senderId: openid, messageId: id, text: decision.text, truncated: decision.truncated,
      untrusted: decision.untrusted, mirror, receivedAt: new Date(receivedMs) };
    inflight.set(id, buildPayload(base));
    try {
      let media = [];
      if (toFetch.length) {
        try { media = await fetchMedia(toFetch); } catch (e) { logFn(`media handling failed: ${e.label || 'error'}`); media = []; }
        const failed = media.filter((x) => x.error).map((x) => x.error);
        logFn(`inbound media ${media.map((x) => x.kind).join(',')}${failed.length ? ` (failed: ${failed.join(',')})` : ''}`);
      }
      logFn(`inbound text len=${text.length}${decision.truncated ? ' (truncated)' : ''}${media.length ? ` media=${media.length}` : ''}`);
      const payload = buildPayload({ ...base, media });
      const ok = await forward(payload);
      if (guard.recordDelivery) guard.recordDelivery(ok);
      if (ok) return 'forwarded';
      try { store.appendUndelivered(payload); } catch { /* ignore */ }
      return 'undelivered';
    } finally { inflight.delete(id); }
  }

  /**
   * Shutdown helper: write payloads for messages that were cut off (in flight) or never started (queued) to
   * undelivered, flagged interrupted. Queued events still pass dedupe and the guard. Returns the count written.
   */
  function salvage(queuedEvents = []) {
    let n = 0;
    for (const p of inflight.values()) { try { store.appendUndelivered({ ...p, interrupted: true }); n++; } catch { /* ignore */ } }
    inflight.clear();
    for (const d of queuedEvents) {
      const { id, openid } = ids(d);
      if (!id || !openid || seen.has(id)) continue;
      remember(id);
      const collected = collectAttachments(d);
      const text = eventText(d, collected);
      const decision = guard.check(openid, text);
      if (!decision.forward) continue;
      const p = buildPayload({ source: 'qq', senderId: openid, messageId: id, text: decision.text, truncated: decision.truncated,
        untrusted: decision.untrusted, mirror });
      try { store.appendUndelivered({ ...p, interrupted: true, attachments: collected.length }); n++; } catch { /* ignore */ }
    }
    return n;
  }

  handleC2C.salvage = salvage;
  handleC2C.inflight = inflight;
  return handleC2C;
}

module.exports = { makeC2CHandler, SEEN_MAX, VOICE_PREFIX };

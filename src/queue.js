'use strict';
// Serial work queue for inbound events: one message is handled at a time, in arrival order, so a burst of
// messages with large attachments cannot exhaust memory, and the webhook sees messages in order.
// When more than maxPending events wait, new ones are refused (onOverflow) instead of queueing without bound.

function createSerialQueue({ worker, maxPending = 100, onOverflow = () => {}, onError = () => {} }) {
  const pending = [];
  let running = null; let current = null; let closed = false;
  const idleWaiters = [];

  function pump() {
    if (running || !pending.length) {
      if (!running && !pending.length) while (idleWaiters.length) idleWaiters.shift()();
      return;
    }
    current = pending.shift();
    running = Promise.resolve().then(() => worker(current))
      .catch((e) => { try { onError(e); } catch { /* ignore */ } })
      .finally(() => { running = null; current = null; pump(); });
  }

  return {
    /** Queue an item. Returns false (and calls onOverflow) when the queue is full or closed. */
    push(item) {
      if (closed || pending.length >= maxPending) { try { onOverflow(item); } catch { /* ignore */ } return false; }
      pending.push(item); pump(); return true;
    },
    /** Stop accepting new items. */
    close() { closed = true; },
    /** Resolves true when everything queued so far is done, or false after timeoutMs. */
    drain(timeoutMs = 10_000) {
      if (!running && !pending.length) return Promise.resolve(true);
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        t.unref?.();
        idleWaiters.push(() => { clearTimeout(t); resolve(true); });
      });
    },
    /** Items not started yet (removed from the queue) plus the one in progress (left as is). */
    takeUnfinished() { const waiting = pending.splice(0); return { current, waiting }; },
    get size() { return pending.length + (running ? 1 : 0); },
  };
}

module.exports = { createSerialQueue };

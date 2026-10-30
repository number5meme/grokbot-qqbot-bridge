# qqbot-relay (Cloudflare Worker)

An always-on relay for hosts that sleep. QQ pushes events in **Webhook** mode (HTTP callback) to this Cloudflare
Worker, and the Worker forwards each `C2C_MESSAGE_CREATE` (one-to-one) message to the same webhook the WebSocket bridge
uses, with the same JSON payload. Your webhook (for example a Grok Bot routine) is woken directly, so messages are
received even while the bridge machine is asleep. Replies are still sent from the machine with `reply.sh`.

```
 QQ user ──> QQ bot ──> QQ webhook push (HTTPS) ──> qqbot-relay (Cloudflare Worker) ── HTTPS POST (JSON) ──> your webhook
                        QQ OpenAPI <── HTTPS ── reply.sh / relay/note-inbound.sh / relay/fetch-media.sh <── your agent
```

> **Mainland China reachability.** `*.workers.dev` is generally unreachable from QQ's servers in mainland China.
> QQ's callback URL validation then never reaches the Worker, and the console shows a misleading
> **"signature check failed"** error. Bind a **Workers Custom Domain** on a domain in your Cloudflare account (for
> example `qqbot.example.com`, see [Setup](#setup)) and use that as the callback URL.

## Protocol handling (QQ Bot docs: Webhook, Security and authorization)

- Ed25519 key: seed = bot secret repeated until it is at least 32 bytes, first 32 bytes.
- `op: 13` (callback URL validation): responds `{"plain_token", "signature"}` with
  `signature = hex(Ed25519_sign(event_ts + plain_token))`. Not signature-checked (like Tencent's Go SDK).
- Every other request must carry `X-Signature-Ed25519` (hex, 64 bytes) and `X-Signature-Timestamp`, verified over
  `timestamp + raw body`; otherwise 401.
- `op: 0` dispatch: answered at once with the HTTP Callback ACK `{"op":12,"d":0}` (the format of Tencent's Go SDK;
  `d: 1` would ask the platform to retry). Forwarding runs afterwards in `ctx.waitUntil`.
- `op: 1` (HTTP heartbeat, if ever sent): `{"op":11,"d":<seq>}`.
- Only `C2C_MESSAGE_CREATE` is forwarded, like the bridge; other events are acknowledged and ignored.

## Bridge semantics mirrored

- Text = trimmed `content` plus each voice transcript (`asr_refer_text`) on its own line prefixed `[voice] `.
- Owner protection (`OWNER_PROTECTION=on`): only `OWNER_ID` and `ALLOWLIST` are forwarded, payloads carry
  `untrusted: true` and `handling_hint`; per-sender `RATE_LIMIT_PER_MIN` and `GLOBAL_RATE_LIMIT_PER_MIN` apply (per
  Worker isolate, best effort). The Worker is stateless, so there is no first-sender binding: set `OWNER_ID`.
  With protection off (default) every sender is forwarded with `untrusted: false`; the global limit still applies.
- `MAX_MESSAGE_CHARS` truncation without splitting a surrogate pair; `MIRROR_TO_MAIN_CHAT` -> `mirror`;
  `ACCEPT_MEDIA` -> `media`.
- Messages whose author is flagged `bot` are dropped.
- Dedupe by event `id` and message `id`, best effort: in memory per isolate, plus the Cache API where available.
- Forwarding: 3 attempts (backoff 1 s, 3 s; 8 s timeout each) on network errors, timeouts, 408, 429 and 5xx;
  redirects are not followed. Nothing secret and no message text is logged.

## Payload

Keys and order as the bridge: `source` ("qq"), `sender_id` (user_openid), `message_id`, `text`, `truncated`,
`received_at`, `untrusted`, `mirror`, optional `media`, optional `handling_hint` (only when `untrusted` is true).

Two steps the agent has to run on the machine, because the Worker cannot write files there. Put both in your routine
instructions (see `docs/routine-prompt.md`); when `untrusted` is true, `handling_hint` repeats them.

1. **Passive replies.** The bridge records the latest message id per sender so `reply.sh` can send a passive reply
   (QQ refuses most other replies). Before replying, record the relayed message the same way:

   ```sh
   relay/note-inbound.sh --sender '<sender_id>' --message-id '<message_id>' --received-at '<received_at>'
   ```

2. **Media.** Each entry has the bridge's failed-download shape
   `{ kind, transcript?, path: null, content_type: null, size: null, error: "NOT_DOWNLOADED", filename? }` plus `url`,
   `declared_content_type`, `declared_size`, and `width` / `height` for images. A voice note with only a transcript has
   no `error`, like the bridge. Fetch a file (QQ URLs expire, so do it promptly):

   ```sh
   relay/fetch-media.sh --kind <kind> --url '<url>' [--filename '<filename>']
   ```

   It uses the bridge's media code (allowed hosts, `MEDIA_MAX_MB`, SILK to WAV, `MEDIA_DIR`) and prints the usual media
   entry with a local `path`.

## Configuration

`wrangler.toml` `[vars]`: `OWNER_PROTECTION`, `RATE_LIMIT_PER_MIN`, `GLOBAL_RATE_LIMIT_PER_MIN`, `MAX_MESSAGE_CHARS`,
`MIRROR_TO_MAIN_CHAT`, `ACCEPT_MEDIA`.

Secrets (`npx wrangler secret put NAME`, value read from stdin; changing a secret needs no code redeploy):

| Secret | Required | Meaning |
| --- | --- | --- |
| `QQBOT_APP_SECRET` | yes | the bot's AppSecret (signs the validation, verifies every event) |
| `WEBHOOK_URL` | yes | webhook to POST payloads to (same as `FORWARD_WEBHOOK_URL`) |
| `WEBHOOK_AUTH` | yes | full `Authorization` header value, e.g. `Bearer <key>` (same as `FORWARD_WEBHOOK_AUTH`) |
| `OWNER_ID`, `ALLOWLIST` | with protection on | senders that are forwarded when `OWNER_PROTECTION=on` |
| `QQBOT_APP_ID` | optional | informational only |

## Setup

1. Deploy the Worker (needs a free Cloudflare account and an API token with the "Edit Cloudflare Workers" template):

   ```sh
   cd relay
   npm install
   export CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id>
   npx wrangler deploy
   npx wrangler secret put QQBOT_APP_SECRET
   npx wrangler secret put WEBHOOK_URL
   npx wrangler secret put WEBHOOK_AUTH
   ```

   (Or pipe values: `printf '%s' "$VALUE" | npx wrangler secret put NAME`.)

2. Give the Worker a URL that QQ can reach. For bots used from mainland China this must be a **Workers Custom
   Domain**, not `workers.dev`: put a domain in your Cloudflare account, then Workers -> `qqbot-relay` -> Settings ->
   Domains & Routes -> Add -> Custom Domain (for example `qqbot.example.com`). Alternatively add to `wrangler.toml`:

   ```toml
   routes = [{ pattern = "qqbot.example.com", custom_domain = true }]
   ```

   and run `npx wrangler deploy` again. Cloudflare serves it over HTTPS on port 443 (QQ allows 80, 443, 8080 and 8443).

3. In the QQ Open Platform bot console, open the development settings, **Event subscription and callback address**:
   - switch the delivery mode from **WebSocket** to **Webhook** (takes effect immediately);
   - enter the callback URL `https://qqbot.example.com/` and let the platform validate it (validation can lag a
     little; retry if it fails at first, and see the reachability note above for "signature check failed");
   - tick the single-chat message event **C2C_MESSAGE_CREATE**; other events are not needed.

   The **server IP whitelist** is unaffected: it only restricts OpenAPI calls (made by `reply.sh` from your machine),
   not callbacks.

4. Send the bot a message and check `npx wrangler tail qqbot-relay`.

5. Stop the WebSocket bridge (`./stop.sh` in the repository root). In Webhook mode it no longer receives anything. Keep
   using `reply.sh`, `relay/note-inbound.sh` and `relay/fetch-media.sh` on the machine.

## Caveats

- Dedupe is best effort; a QQ redelivery that lands on another isolate can be forwarded twice.
- There is no retry queue: if all 3 attempts fail, the message is only logged (`wrangler tail`). The bridge's
  `state/undelivered.jsonl` and `replay.sh` do not apply.
- The request timestamp is not checked for age (the platform docs do not require it).
- Owner protection has no first-sender binding, and rate limits are per isolate.
- Passive replies depend on the agent running `note-inbound.sh` before `reply.sh`; without it replies fall back to
  active messages, which QQ refuses for most bots.

## Tests

```sh
cd relay && npm test     # or, from the repository root: npm run test:relay
```

Covers the key-derivation and callback-validation examples from the QQ docs, request signatures, payload equality with
the bridge's own mapping code, guard behaviour, and forwarding against a local mock webhook. No network access is
needed.

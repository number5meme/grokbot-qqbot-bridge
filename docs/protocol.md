# QQ Bot API v2 notes

The parts of the official QQ Bot Open Platform API v2 that this bridge uses. Sources: the public documentation at
<https://bot.q.qq.com/wiki/> and Tencent's open-source SDK `@tencent-connect/qqbot-nodejs`.

## Access token

```
POST https://bots.qq.com/app/getAppAccessToken
{"appId": "<AppID>", "clientSecret": "<AppSecret>"}
-> {"access_token": "...", "expires_in": "7200"}      (expires_in is a string)
```

Errors still return HTTP 200 with a body like `{"code": 100016, "message": "invalid appid or secret"}`.
The bridge refreshes about 5 minutes before expiry (or at a third of the remaining lifetime for short tokens), with one
refresh in flight at a time. Requests use `Authorization: QQBot <access_token>`.

## Gateway (WebSocket, outbound only)

1. `GET {api}/gateway` -> `{"url": "wss://..."}`.
2. Server sends HELLO: `{"op": 10, "d": {"heartbeat_interval": 41250}}`.
3. Client sends IDENTIFY: `{"op": 2, "d": {"token": "QQBot <token>", "intents": 33554432, "shard": [0, 1]}}`
   (`1 << 25` = group and C2C events), or RESUME: `{"op": 6, "d": {"token": "QQBot <token>", "session_id": "...", "seq": N}}`.
4. READY (`t: "READY"`, store `session_id`) or RESUMED.
5. Heartbeat `{"op": 1, "d": <last seq or null>}` every interval; server answers `{"op": 11}`.
6. Events: `{"op": 0, "s": seq, "t": "C2C_MESSAGE_CREATE", "d": {"id": "...", "author": {"user_openid": "..."}, "content": "...", "attachments": [...]}}`.
   The same message can be delivered more than once; dedupe by `d.id`.

| op / close code | meaning | bridge behavior |
|---|---|---|
| op 7 | server asks to reconnect | reconnect after 1 s and RESUME |
| op 9, `d: true` | invalid session, resumable | RESUME after 3 s |
| op 9, `d: false` | invalid session | clear session, refresh token, IDENTIFY after 3 s |
| 4004 | invalid token | refresh token, reconnect |
| 4006, 4007, 4900-4913 | session invalid or server error | clear session, refresh token, IDENTIFY |
| 4008 | rate limited | wait 60 s |
| 4009 | session timed out | refresh token, RESUME |
| 4013, 4014 | intents not allowed | fatal `INTENT_DENIED` (exit 18) |
| 4914 | bot delisted (sandbox only) | fatal `BANNED` (exit 15) |
| 4915 | bot banned | fatal `BANNED` (exit 15) |
| 1000/1006/other | normal or abnormal close | backoff, then RESUME |

## Sending

```
POST {api}/v2/users/{openid}/messages
{"content": "text", "msg_type": 0, "msg_id": "<inbound id>", "msg_seq": 1}     passive reply
{"content": "text", "msg_type": 0}                                            active message
```

- Passive replies: within 60 minutes of the inbound message, up to 4 per message, each with a distinct `msg_seq`.
  A duplicate `msg_id` + `msg_seq` returns `40054005`. `reply.sh` holds `state/reply.lock` while sending, so concurrent
  calls never reuse a `msg_seq`.
- Active messages (no `msg_id`): QQ stopped delivering them for most bots on 2025-04-21. The bridge still tries one
  after the passive window or quota is used up (the platform decides), and maps a refusal (`40034100`, `40034105`,
  `40054013`) to `ERROR REPLY_WINDOW` (exit 3): the user has to write again.
- Media: `POST /v2/users/{openid}/files {"file_type": <n>, "srv_send_msg": false, "file_data": "<base64>"}` -> `file_info`
  (`file_type`: 1 image, 2 video, 3 voice, 4 file; files also send `"file_name"`; `url` instead of `file_data` uploads
  from a public URL), then send `{"msg_type": 7, "media": {"file_info": "..."}, "content": "<caption>"}` with the same
  passive/active rules. The bridge sends `" "` as content for images without a caption and omits content for voice and
  files without a caption (as the official SDK does). `srv_send_msg: true` would send directly but uses the active quota.
- Limits from the rich-media overview: image png/jpg 20 MB soft / 200 MB hard, video mp4 30 MB, voice silk 20 MB, file
  200 MB; above the soft limit the platform downgrades to a file. Large files should use chunked upload
  (`upload_prepare`, part PUTs, `upload_part_finish`), which this bridge does not implement: it uploads up to 10 MB in
  one base64 request.
- Voice formats: the overview lists silk / mp3 / wav / ogg, the upload table lists silk only. The official SDK uploads
  `.silk`, `.wav`, and `.mp3` directly without transcoding; the bridge accepts exactly those three.

## Inbound attachments

`C2C_MESSAGE_CREATE` `d.attachments[]`: `url`, `filename`, `content_type` (`image/jpeg|png|gif`, `video/mp4`, `voice`,
`file`, ...), `size`, `width`, `height`; voice may also carry `voice_wav_url` (a WAV rendition) and `asr_refer_text`
(QQ's speech recognition). Either may be absent. URLs can start with `//` (prepend `https:`).
The official plugin (`@tencent-connect/openclaw-qqbot`, `src/middleware/attachment.ts`) treats an attachment as voice when
`content_type` is `voice` or `audio/*`, or the file name ends in `.amr`, `.silk`, `.slk`, or `.slac`; prefers
`voice_wav_url`, else converts the SILK from `url` to WAV (24 kHz) with `silk-wasm`; and uses `asr_refer_text` as the
transcript. Downloads are plain https GETs.

## Gateway robustness notes

- op 9 (invalid session): wait at least 3 s, growing with the normal reconnect backoff when it repeats, then RESUME
  (`d: true`) or IDENTIFY with a fresh token (`d: false`).
- Inbound events are handled one at a time in arrival order (queue of at most 100 waiting events), so webhook calls are
  never reordered or run in parallel. On stop, events still waiting or in progress after `BRIDGE_STOP_GRACE_MS` are
  written to `undelivered.jsonl` with `"interrupted": true`.
- Attachment URLs are downloaded only from Tencent hosts (`qq.com`, `qq.com.cn`, `qpic.cn`, `qlogo.cn`, plus
  `MEDIA_ALLOWED_HOSTS`); redirects are followed by hand (at most 3) and each hop is checked again.

## Error codes

| code | meaning | bridge behavior |
|---|---|---|
| HTTP 401, 11241, 11242, 11243, 40012001 | token missing, invalid, or expired | refresh token once and retry |
| 100016, 100007, 10004, 11251, 11261, 11275 | bad AppID/AppSecret, or bot missing | fatal `BAD_CREDENTIALS` (exit 16) |
| 11298 | source IP not in the IP whitelist | fatal `IP_WHITELIST` (exit 17) |
| 11265 | bot banned | fatal `BANNED` (exit 15) |
| 304103, 40034005, 40034128, 304026, 304027, 40034024 | passive reply window or quota expired | fall back to an active message |
| 304003 | URL not allowed | retry once with links removed |
| 40034100, 40034105, 40054013 (on an active message) | active messages not available or refused | `ERROR REPLY_WINDOW`, exit 3 |
| 40054013, 40034105 (other cases) | user refuses active messages, or no permission | reported to the caller |

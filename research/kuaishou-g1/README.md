# Kuaishou G1 research probe

Zero-dependency Node.js PoC for the Kuaishou G1 investigation. It is **not** a
LiveMemory platform adapter and is not imported by `src/`.

## What it does

| Command | Purpose | Status |
| --- | --- | --- |
| `discover` | list public live rooms from `live_api/home/list` | real, anonymous |
| `status` | live/offline via the public room page SSR | real, anonymous; detects "请求过快" rate limiting |
| `watch` | collect anonymous H5 chat at ~3.2s/room and print aggregates | real, anonymous |
| `ws-anon` | one unsigned `websocketinfo` request | real; records the rejection |
| `qr-probe` | one unsigned QR-start request; `--flow` also polls once | real; QR start succeeds without signature |
| `login` | QR login, then in-memory live-session probe | stops at the human scan; no credential is written |
| `auth` | explains why no login session is configured | informational |
| `cleanup` | deletes `research/kuaishou-g1/.state/` | local only |

## What it deliberately does not do

- No Cookie import, no password, no developer API key.
- No `__NS_hxfalcon` / `__NS_sig3` reimplementation, no TLS impersonation,
  no device-fingerprint generation, no captcha/slider solving.
- No chat text, nickname, avatar, userId list or credential is written to disk
  or committed. `watch` keeps only aggregates in memory.
- No chat/gift/like/follow/share is sent.
- A rejected request is recorded once; it is not retried with evasion.

The login-state WebSocket is not implemented. `login` only tests whether the
official QR endpoints and the live-site ticket exchange accept an unsigned,
session-backed request. If a future approved design needs the non-public
signature, that is a separate compliance decision.

## Usage

```bat
node research/kuaishou-g1/probe.mjs discover --limit 8
node research/kuaishou-g1/probe.mjs status --room https://live.kuaishou.com/u/<eid>
node research/kuaishou-g1/probe.mjs watch --room <eid> --room <eid> --seconds 120
node research/kuaishou-g1/probe.mjs watch --target <eid>:<liveStreamId> --seconds 7200 ^
  --out research/kuaishou-g1/.state/run.json
node research/kuaishou-g1/probe.mjs watch --target <eid>:<liveStreamId> --seconds 240 ^
  --drop-at 60 --drop-ms 20000
node research/kuaishou-g1/probe.mjs ws-anon --room <eid>
node research/kuaishou-g1/probe.mjs qr-probe --flow
node research/kuaishou-g1/probe.mjs login --room <eid> --wait 180
node research/kuaishou-g1/probe.mjs cleanup
```

`watch --target` is for a liveStreamId obtained from `discover`; it skips the
SSR lookup, which is useful when the room page is rate-limited. `--drop-at`
and `--drop-ms` simulate a local network outage (requests are paused, not
failed) so reconnect/cursor behaviour can be observed without touching the
network.

## Login session handling

`login` keeps cookies and tokens **in memory only**:

- the QR PNG is written to `research/kuaishou-g1/.state/qr.png` so a human can
  scan it; it is not a credential by itself and expires quickly;
- no `session.json` is created, no cookie/token is logged;
- `cleanup` removes the QR file and the whole `.state` directory.

If a later experiment needs persistence, it must reuse LiveMemory's
`EncryptedJsonStore` (AES-256-GCM + per-install key + best-effort `icacls`),
state the exact path, and offer a one-click clear action.

## Observed on 2026-11-17 (Asia/Shanghai)

- `discover`: HTTP 200, 46–48 live rooms in the public home list.
- `watch` smoke (3 rooms, 45s): 6 messages, 100% nickname/userId/time/headurl,
  0% messageId, 0 duplicates, p50 latency 2.97–3.43s.
- `watch` 2h (3 rooms, 7,203s): 555 messages / 229 users, 0 duplicates,
  0 HTTP errors, 100% field coverage, 0% messageId, p50 ≈ 3.1s;
  cross-room user overlap 0. One room returned `result:601`
  (`error_msg:"直播已停止"`) after ~13 minutes; the probe now stops that room
  on 601 instead of polling a dead stream.
- `ws-anon`: `{"data":{"result":2}}`, no token/URLs.
- `qr-probe`: unsigned `/qr/start` returned `result:1` with `qrUrl`,
  `qrLoginToken` and a base64 PNG; unsigned `scanResult`/`acceptResult`
  returned `707` (no scan), not a signature error.
- Repeated SSR room-page loads returned a 57,783-byte page with
  `"errorType":{"type":2,"title":"请求过快，请稍后重试"}`. Treat it as
  `RATE_LIMITED`, never as "offline".

The full evidence, scoring and decision are in `docs/KUAISHOU_G1_POC.md`.

# Kuaishou G1.5/G1.6 research prototype

Zero-dependency Node.js prototype for the Kuaishou G1.5 dual-mode and G1.6 WebSocket-token
investigations. It is **not** a LiveMemory platform adapter and is **not** imported by `src/`.

Read first: [`docs/KUAISHOU_G1_6_WEBSOCKET_BLOCKED.md`](../../docs/KUAISHOU_G1_6_WEBSOCKET_BLOCKED.md)
and the earlier [`docs/KUAISHOU_G1_5_DUAL_MODE.md`](../../docs/KUAISHOU_G1_5_DUAL_MODE.md).

## Current status (2026-11-17)

| Route | Status | Meaning |
| --- | --- | --- |
| Anonymous H5 (`wap/live/feed`) | **POLICY-BLOCKED** | Kuaishou's user agreement forbids robot/spider monitoring and requires written permission; the H5 host's `robots.txt` is `Disallow: /` for `User-agent: *`. Do not ship. |
| Authenticated WebSocket | **login REAL-VERIFIED; token endpoint BLOCKED under the clean-client boundary** | G1.6 completed a second real phone scan, then called `websocketinfo` on eight ids from a fresh `home/list` snapshot (top room: 9,427 watching). All eight returned HTTP 200 `result:2`, no token/URLs, with a valid `userLogin`. The stale-ID explanation is now ruled out; the endpoint needs an additional client-side gate (signature/device/risk cookies) that this prototype deliberately does not implement. |
| Identity | **NOT PROVEN** | No cross-room, cross-day or cross-route evidence. `h5:` and `ws:` ids are kept in separate namespaces by construction. |
| Gifts / likes / shares | **CODE-SUPPORTED / NOT-OBSERVED** | The web protocol defines the fields; no real event was received. |

Because of the above, G1.5 concluded **D — do not enter G2**. G1.6 repeated the
login with a fresh-room method and confirmed the WebSocket token endpoint is not
available to this clean client; see `docs/KUAISHOU_G1_6_WEBSOCKET_BLOCKED.md`.

## Commands

```bat
:: compliance verdict (no network)
node research/kuaishou-g1_5/probe.mjs policy

:: public live-room list (anonymous home/list)
node research/kuaishou-g1_5/probe.mjs rooms --limit 8

:: one room's live status (rate limit is never reported as offline)
node research/kuaishou-g1_5/probe.mjs status --room <eid>

:: QR login + controlled token probe + optional read-only listen
node research/kuaishou-g1_5/probe.mjs login --room <live-eid> --wait 600 --listen 120 --probe

:: G1.6: fresh-room snapshot -> QR login -> try 8 newest live ids -> optional listen
node research/kuaishou-g1_5/live-probe.mjs --wait 600 --listen 120 --candidates 8

:: H5 reproduction — refused unless the block is explicitly acknowledged
node research/kuaishou-g1_5/probe.mjs h5 --room <eid> --live-stream-id <id> --seconds 60 --acknowledge-blocked

:: unit tests (offline, no network)
node --test --test-isolation=none research/kuaishou-g1_5/tests/prototype.test.mjs

:: remove the local QR/status state
node research/kuaishou-g1_5/probe.mjs cleanup
```

## QR login — what the operator does

1. Start `probe.mjs login --room <live-eid> ...`.
2. Open `scan.html` in a browser (it shows the current QR at 460×460 and reloads it every 3 seconds).
3. Scan with the Kuaishou app, confirm on the phone.
4. The probe continues automatically: `passToken` → live ticket → `userLogin` → `websocketinfo` → optional listen.

The QR lives about 58 seconds. The probe refreshes it automatically on `707`; `scan.html` follows the
file, so the operator always scans the current code.

**What is never written:** cookies, `passToken`, auth tokens, chat text, nicknames, avatars.
The only files are `.state/qr.png` (a QR image, not a credential), `.state/login-status.json`
(stage/result/cookie **names**), and `.state/ws-evidence.json` (aggregates only) if a listen happens.

## Layout

```text
probe.mjs                 CLI (policy/rooms/status/h5/login/selftest/cleanup)
live-probe.mjs            G1.6 fresh-room login + multi-id token probe
lib/link.mjs              live-room URL / bare id parsing
lib/status.mjs            home/list status detector, rate-limit aware
lib/h5-transport.mjs      AnonymousH5Transport (policy-gated)
lib/ws-transport.mjs      AuthenticatedWebSocketTransport
lib/ws-protocol.mjs       envelope, enter/leave/heartbeat, feed decoding
lib/protobuf.mjs          minimal protobuf wire codec
lib/normalize.mjs         canonical event mapping (validated by src/shared/events.mjs)
lib/identity.mjs          namespaced identity + evidence-only linking
lib/login.mjs             browser-free QR login and live ticket exchange
lib/errors.mjs            error taxonomy and business-code mapping
lib/http.mjs              fetch wrapper, in-memory cookie jar, cancellable sleep
tests/prototype.test.mjs  10 offline tests
evidence/                 sanitized G1.6 WebSocket-probe evidence
scan.html                 large auto-refreshing QR page for the human
```

## Safety boundaries (enforced, not aspirational)

- No `__NS_hxfalcon` / `__NS_sig3`, no device fingerprint, no webweapon/gdfp, no captcha solving,
  no TLS impersonation, no paid signing, no third-party relay.
- No Cookie import, no password, no developer API key.
- No chat/gift/like/follow/share is ever sent.
- A rejected request is recorded once; it is not retried with evasion.
- `AnonymousH5Transport` throws `POLICY_BLOCKED` unless `acknowledgePolicy: true` is passed, and the
  CLI additionally requires `--acknowledge-blocked`. This is a deliberate guard, not a convenience.
- `websocketinfo` is refused when the live room cannot be confirmed live, so an already-ended stream
  can never be misreported as "the token endpoint rejected us".

## Evidence (2026-11-17, Asia/Shanghai)

- `qr/start` unsigned: `result:1`, 125×125 PNG, ~58s expiry.
- Real phone scan: `scanResult=1` → `acceptResult=1` → `passToken` → `getCdns=1` →
  live `passToken` exchange `result:1` → `userLogin=1` (`live.web_st/_ph`).
- `websocketinfo` (7-minute-old `liveStreamId`): `result:2`, no token; room confirmed offline at 18:44.
- `home/list`: 48 live rooms at 18:34 and 18:43; target absent at 18:44.
- Unit tests: **10 passed / 0 failed**.

## G1.6 evidence (2026-11-17 20:10–20:19, Asia/Shanghai)

- First attempt (`probe.mjs login`): real scan → `passToken` → live ticket → `userLogin=1`;
  `websocketinfo` on the pre-scan id returned `result:2`. The room list rotates, so the
  old id was not a valid control.
- Second attempt (`live-probe.mjs`): real scan → `userLogin=1`, then a fresh `home/list`
  snapshot. Eight ids (9,427 down to 819 watching) were tested immediately:
  **8/8 HTTP 200 `result:2`, 0 token, 0 WebSocket URL**.
- This rules out “the old room had ended” as the explanation for the G1.5 result.
  The remaining explanations require signing, device/risk cookies, or a browser-only
  client gate; implementing them would violate the project boundary, so the route stops here.
- No credentials, chat text, nickname or avatar were written. `.state/` is untracked.

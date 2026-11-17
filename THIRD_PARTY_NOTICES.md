# Third-party notices

LiveMemory's own source code is licensed under the MIT License (see `LICENSE`).
This file lists components whose license differs.

## Douyin signature scripts — AGPL-3.0

The following files are **not** MIT-licensed. They are a separate AGPL-3.0
component, loaded at runtime in a `node:vm` sandbox:

- `src/platforms/douyin/vendor/sign.js`
- `src/platforms/douyin/vendor/LICENSE-AGPL-3.0.txt`

Upstream: [saermart/DouyinLiveWebFetcher](https://github.com/saermart/DouyinLiveWebFetcher),
redistributed via [ymstar/dyhub](https://github.com/ymstar/dyhub/tree/main/third_party/douyin-sign).
License: GNU Affero General Public License v3.0.

Because the Windows EXE embeds these files, **a binary distribution that includes
them must satisfy AGPL-3.0**: the complete corresponding source (including these
exact files) must be made available under AGPL-3.0, and the license notices must
be kept. See `docs/LICENSE_AGPL_DOUYIN.md` and `src/platforms/douyin/vendor/README.md`.

SHA-256 of the vendored file (2026-11-15, identical to dyhub `main`):

- `sign.js`: `81fb78a5e8728af99ffb9d20625b01bcedc43a82b05e3bef79e2bc0d29ccff5d`

The upstream `a_bogus.js` is not shipped (only the WebSocket signature is needed).

## QR code renderer

`src/web/js/vendor/qrcode.js` keeps its own license file
(`src/web/js/vendor/qrcode.LICENSE.txt`).

## TikTok webcast protocol reference — MIT

The TikTok local WebSocket capture (`src/platforms/tiktok/webcast.mjs`,
`local-adapter.mjs`) was written for LiveMemory against the protocol observed in
[talkaboutdesign/tiklive](https://github.com/talkaboutdesign/tiklive), which is
MIT licensed:

```text
MIT License
Copyright (c) 2026 Talkabout Design LLC
```

**No tiklive source file is copied or bundled.** tiklive is built on Effect 4
and Bun; LiveMemory keeps its zero-runtime-dependency rule and reuses its own
protobuf codec (`protobuf.mjs`) and message mapper (`messages.mjs`). The MIT
notice is recorded here because the connection algorithm, frame field numbers
and heartbeat/ack behaviour were derived from reading that project's source
(`packages/core/src/LiveConnection.ts`, `packages/core/src/proto/frames.ts`,
`docs/PROTOCOL.md`), and LiveMemory's implementation is a derivative of that
protocol work.

The protocol itself belongs to TikTok and is **not** an official API: it is
TikTok's private web protocol and can change without notice.

## Kick Centrifugo protocol reference — MIT / Apache-2.0

The Kick chat capture under `src/platforms/kick/` was written for LiveMemory
against the protocol observed live on 2026-11-16/17 and cross-checked by
reading two third-party projects:

- [achrafthedev/kixo](https://github.com/achrafthedev/kixo) — MIT,
  `src/renderer/src/lib/realtime.js` (Centrifugo session, topics, ping/pong,
  token TTL handling).
- [AnisAbdellatif/kicksdk](https://github.com/AnisAbdellatif/kicksdk) —
  dual-licensed MIT OR Apache-2.0, `docs/KICK.md` (five chat feeds, event
  names, disconnect-code semantics, official API boundaries).

**No source file from either project is copied or bundled.** Both are used as
protocol references only: LiveMemory's implementation is its own zero-dependency
Node ESM code (`node:http2`, built-in `WebSocket`), and no package, WASM module
or Rust crate from those projects is shipped or required at runtime.

The Kick realtime feed and `kick.com` website endpoints are **not** an official
API. They are what kick.com's own front end uses, can change without notice,
and are used only as described in `docs/KICK_G1_ACCEPTANCE.md` (anonymous guest
token, no login, no access-control bypass).

## Kuaishou protocol reference — no code bundled

The Kuaishou G0 investigation (`docs/KUAISHOU_G0_FEASIBILITY.md`,
`research/kuaishou-g0/`) read third-party projects only to confirm public
protocol behaviour. **No source file, snippet, protobuf descriptor, model or
binary from any of them is copied, rewritten into `src/`, or bundled.**

| Project | License | How it was used |
| --- | --- | --- |
| [cv-cat/catbus](https://github.com/cv-cat/catbus) | MIT | Read `live.ts`, `commands.ts`, `api.ts`, `client.ts`, `session.ts`, `sign.ts`, `captcha.ts`, `normalize.ts`, `resolve.ts` for the desktop WebSocket/protobuf, login/sig4 requirements, event mapping and arbitrary-room support. |
| [cv-cat/KuaiShou-Spider](https://github.com/cv-cat/KuaiShou-Spider) | **No LICENSE** | Read-only protocol reference (`live_api.py`, `live_proto.py`). No code may be copied. |
| [BarryWangQwQ/UniBarrage](https://github.com/BarryWangQwQ/UniBarrage) | GPL-3.0 + commercial restriction | Read-only (`kuaishou/kuaishou.go`, `LICENSE`). GPL code is not copied into the MIT area. |
| [ykaiqx/Live-Barrage](https://github.com/ykaiqx/Live-Barrage) | MIT | Read-only (`Kwai/barrage.py`); the anonymous H5 feed shape was independently re-requested in 2026. |
| [Superheroff/kuaishou_websocket](https://github.com/Superheroff/kuaishou_websocket) | MIT | Read-only (`main.py`, `kuaishou_pb2.py`); used to confirm `SCWebFeedPush` fields and login/browser requirements. |
| [atvkh/kuaishou-live-mate](https://github.com/atvkh/kuaishou-live-mate) | MIT | Read-only (`README.md`, `src/danmu.py`, `src/platforms/kuaishou.py`); confirmed QR login + Playwright interception. |
| [wushuaihua520/BarrageGrab](https://github.com/wushuaihua520/BarrageGrab) | AGPL-3.0 | Metadata/positioning only; not executed, not copied. |
| [Ikaros-521/AI-Vtuber](https://github.com/Ikaros-521/AI-Vtuber) | GPL-3.0 | Metadata only; its Kuaishou implementation was not copied. |
| [xuanxuan123xuan/simple-live-kuaishou](https://github.com/xuanxuan123xuan/simple-live-kuaishou) | GPL-3.0 | Metadata only; not copied. |
| [frostynight-furry/furryup-live-connect](https://github.com/frostynight-furry/furryup-live-connect) | MIT | Metadata only; not copied. |

The Kuaishou live H5 feed and desktop WebSocket are **not** an official API.
They are what Kuaishou's own web clients use, can change without notice, and
are subject to Kuaishou's terms and `robots.txt`. See
`docs/KUAISHOU_G0_FEASIBILITY.md` §12 and `docs/KUAISHOU_G1_POC.md` §11 for the
platform-rule risk.

### G1 addendum (2026-11-17)

`docs/KUAISHOU_G1_POC.md` and `research/kuaishou-g1/` add no third-party code
and no runtime dependency. The G1 review read catbus's `sign.ts` (pure-JS
`__NS_hxfalcon` / `__NS_sig3` reimplementation), `captcha.ts` (automatic slider
captcha solving) and `package.json` (18 runtime dependencies, including
`wreq-js`, which advertises TLS/JA3/JA4 browser-fingerprint impersonation).
Those mechanisms are **not** copied, bundled, or used; they are recorded only
as evidence of why the catbus login/WebSocket path is not acceptable for
LiveMemory. catbus's MIT `LICENSE` permits commercial reuse, while its
`README.zh-CN.md` asks for study/research use only; that inconsistency is
documented in `docs/KUAISHOU_G1_POC.md` §11.2.

### G1.5 addendum (2026-11-17)

`docs/KUAISHOU_G1_5_DUAL_MODE.md` and `research/kuaishou-g1_5/` add no
third-party code and no runtime dependency. Two kinds of protocol facts were
used:

- **Live WebSocket message layout.** Envelope field numbers, payload-type
  numbers and feed field numbers were read from Kuaishou's public web-client
  message definitions as republished in catbus's MIT-licensed
  `static/kuaishou/fixtures/` files. Only numeric field facts were used to
  hand-write `lib/protobuf.mjs` and `lib/ws-protocol.mjs`. No descriptor file,
  schema JSON, mapping file or source file is copied, adapted, or bundled.
- **AES-128-CBC envelope constant.** The key/IV pair is a transport constant
  from Kuaishou's own web-client bundle, used only to decode frames the server
  marks `compressionType=3`. It is symmetric transport encoding, not an
  authentication signature, device fingerprint or access-control bypass.

Everything else in the prototype (QR login flow, live-ticket exchange,
transports, normalizer, identity mapper, status detector, CLI and tests) is
original code written for this repository under its MIT license. The G1.5
implementation does not use catbus's `sign.ts`, `captcha.ts`, `session.ts`
(webweapon/gdfp), `client.ts` (header/cookie line ordering) or `wreq-js`, and
does not use any paid signing, browser relay or cloud relay service.

Official Kuaishou texts quoted in the report (user agreement, live service
agreement, live management rules, `robots.txt`) are cited for compliance
review only; they are not redistributed as files.

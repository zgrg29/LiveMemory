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

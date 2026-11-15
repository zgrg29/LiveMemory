# Douyin signature asset (third-party, AGPL-3.0)

This file is **not** part of LiveMemory's MIT-licensed source. It is a vendored
third-party asset that LiveMemory loads at runtime inside a `node:vm` sandbox to
compute the Douyin web-client request signature.

| File | Purpose | Upstream |
| --- | --- | --- |
| `sign.js` | WebSocket handshake `signature` (webmssdk deobfuscation) | [saermart/DouyinLiveWebFetcher](https://github.com/saermart/DouyinLiveWebFetcher) (AGPL-3.0), redistributed via [ymstar/dyhub](https://github.com/ymstar/dyhub/tree/main/third_party/douyin-sign) |
| `LICENSE-AGPL-3.0.txt` | Full AGPL-3.0 license text | GNU / SPDX |

The `a_bogus.js` utility from the same upstream is **not** shipped: this product
only needs the WebSocket signature, and keeping the footprint minimal reduces the
combined-work obligation. The login investigation references `a_bogus` only as a
platform-side requirement.

## License obligations (read before distributing a binary)

- The upstream file is licensed under **AGPL-3.0**. LiveMemory itself stays
  MIT-licensed; this directory is a separate AGPL-3.0 component.
- Distributing a Windows EXE that contains this file (the build embeds every
  file under `src/`) means the combined distribution must satisfy AGPL-3.0:
  the corresponding source, including this exact file, must be made available
  under AGPL-3.0.
- The project repository is public and contains this exact file, so the
  source-offer obligation can be met by pointing recipients at the repository
  and the upstream link above. Keep this file and the license text with any
  binary distribution.
- The script is executed in a sandbox without filesystem, network, process or
  credential access. It only computes a signature string.

## Risk

The Douyin web-client signature algorithm is not a public, stable API. The
upstream script may stop working when the platform updates its SDK, and the
adapter must then fail visibly instead of silently degrading. LiveMemory does
not bypass login, captcha or access control with this file.

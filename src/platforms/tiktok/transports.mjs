/**
 * TikTok capture transports.
 *
 * `auto`      → prefer the signed poll transport, fall back to the browser relay
 * `signer`    → free community signing endpoint (chat/gift events)
 * `browser`   → experimental Chrome relay over the official live page
 */
export const TIKTOK_TRANSPORTS = Object.freeze(['auto', 'signer', 'browser']);

export const TIKTOK_DEFAULT_TRANSPORT = 'auto';

export function normalizeTikTokTransport(value) {
  const text = String(value ?? '').trim();
  return TIKTOK_TRANSPORTS.includes(text) ? text : null;
}

import {createHash} from 'node:crypto';

/**
 * Bilibili WBI signature.
 *
 * Several live APIs (`getDanmuInfo`, gift panel, …) reject unsigned requests.
 * The signature is a md5 over the sorted, encoded query string plus a "mixin
 * key" derived from the two WBI images published by `nav.wbi_img`.
 *
 * Reference implementation cross-check (bili-gift-drop) and the public test
 * vector are reproduced in tests/unit/bilibili-wbi.test.mjs.
 */

// Byte permutation published with the WBI scheme. It is a constant of the
// platform, not a secret.
export const MIXIN_KEY_ORDER = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
]);

/** `nav.wbi_img.img_url` -> the bare key (filename without extension). */
export function extractWbiKey(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const pathname = new URL(url).pathname;
    const file = pathname.split('/').filter(Boolean).pop() ?? '';
    const key = file.split('.')[0];
    return /^[0-9a-f]{32}$/i.test(key) ? key : null;
  } catch {
    return null;
  }
}

export function mixinKey(imgKey, subKey) {
  if (!imgKey || !subKey) throw new Error('WBI keys are required');
  const source = `${imgKey}${subKey}`;
  return MIXIN_KEY_ORDER.map((index) => source[index] ?? '').join('').slice(0, 32);
}

function encodeValue(value) {
  return encodeURIComponent(String(value).replace(/[!'()*]/g, ''));
}

/**
 * Build the signed query string (without the leading `?`).
 * @param {object} params
 * @param {string} key mixin key
 * @param {{now?: number}} options `now` in milliseconds
 */
export function signParams(params, key, {now = Date.now()} = {}) {
  const values = {...params, wts: Math.floor(now / 1000)};
  const query = Object.keys(values)
    .sort()
    .map((name) => `${encodeURIComponent(name)}=${encodeValue(values[name])}`)
    .join('&');
  const wRid = createHash('md5').update(query + key).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/** Convenience wrapper: signed query from a `nav` response. */
export function signWithNav(params, navData, {now = Date.now()} = {}) {
  const images = navData?.wbi_img ?? navData?.data?.wbi_img;
  const img = extractWbiKey(images?.img_url);
  const sub = extractWbiKey(images?.sub_url);
  if (!img || !sub) throw new Error('nav response has no WBI images');
  return signParams(params, mixinKey(img, sub), {now});
}

export function apiErrorCode(payload) {
  return Number(payload?.code ?? 0);
}

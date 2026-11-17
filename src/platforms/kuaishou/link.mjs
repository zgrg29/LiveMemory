import {KUAISHOU_ERRORS, KuaishouError} from './errors.mjs';

/**
 * Kuaishou room input parsing.
 *
 * Only live-room inputs are accepted. A profile, a short video, a replay or a
 * non-Kuaishou URL is rejected explicitly. The parser never performs a network
 * request, so it remains usable while live collection is disabled.
 */

const EID = /^[0-9A-Za-z_-]{4,40}$/;
const LIVE_HOST = 'live.kuaishou.com';
const H5_HOST = 'livev.m.chenzhongtech.com';

function invalid(message, details = null) {
  return new KuaishouError(KUAISHOU_ERRORS.LINK_INVALID, {
    httpStatus: 400,
    details,
    retryable: false,
    // The service maps this code to a translated key.
    messageKey: 'errors.kuaishouLinkInvalid'
  });
}

export function livePageUrl(eid) {
  return `https://${LIVE_HOST}/u/${encodeURIComponent(eid)}`;
}

export function h5ShareUrl(eid) {
  return `https://${H5_HOST}/fw/live/${encodeURIComponent(eid)}`;
}

/**
 * Accepts:
 *   https://live.kuaishou.com/u/<eid>
 *   https://live.kuaishou.com/u/<eid>?...
 *   https://livev.m.chenzhongtech.com/fw/live/<eid>
 *   bare <eid>
 * Rejects profiles, short videos, photo pages, replays and other platforms.
 *
 * @returns {{eid:string, source:'bare-id'|'live-url'|'h5-share-url', liveUrl:string, h5ShareUrl:string}}
 */
export function parseKuaishouInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw invalid('empty');

  if (EID.test(raw)) {
    return {eid: raw, source: 'bare-id', liveUrl: livePageUrl(raw), h5ShareUrl: h5ShareUrl(raw)};
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('not_a_url');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw invalid('unsupported_protocol');
  if (url.username || url.password) throw invalid('credentials_in_url');

  const host = url.hostname.toLowerCase();
  if (host === LIVE_HOST) {
    const match = /^\/u\/([0-9A-Za-z_-]{4,40})\/?$/.exec(url.pathname);
    if (match) {
      return {
        eid: match[1],
        source: 'live-url',
        liveUrl: livePageUrl(match[1]),
        h5ShareUrl: h5ShareUrl(match[1])
      };
    }
    throw invalid('not_a_live_room', {host, path: url.pathname.slice(0, 80)});
  }

  if (host === H5_HOST) {
    const match = /^\/fw\/live\/([0-9A-Za-z_-]{4,40})\/?$/.exec(url.pathname);
    if (match) {
      return {
        eid: match[1],
        source: 'h5-share-url',
        liveUrl: livePageUrl(match[1]),
        h5ShareUrl: h5ShareUrl(match[1])
      };
    }
    throw invalid('h5_path_not_live', {host, path: url.pathname.slice(0, 80)});
  }

  throw invalid('not_kuaishou', {host: host.slice(0, 80)});
}

export const __internal = {EID, LIVE_HOST, H5_HOST};

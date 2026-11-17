// Kuaishou G1.5 research prototype — room input parsing.
//
// Only live-room inputs are accepted. A profile, a short video, a replay or a
// non-Kuaishou URL is rejected explicitly; the adapter must never silently
// turn "this is not a live room" into an empty recording.

export class LinkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LinkError';
  }
}

const EID = /^[0-9A-Za-z_-]{4,40}$/;

/**
 * Accepts:
 *   https://live.kuaishou.com/u/<eid>
 *   https://live.kuaishou.com/u/<eid>?...
 *   https://livev.m.chenzhongtech.com/fw/live/<eid>
 *   bare <eid>
 * Rejects everything else, including /profile/, /short-video/, /photo/.
 */
export function parseRoomInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new LinkError('直播间不能为空');

  if (EID.test(raw)) return {eid: raw, source: 'bare-id'};

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new LinkError('不是有效的直播链接或主播 ID');
  }
  const host = url.hostname.toLowerCase();

  if (host === 'live.kuaishou.com') {
    const m = /^\/u\/([0-9A-Za-z_-]{4,40})\/?$/.exec(url.pathname);
    if (m) return {eid: m[1], source: 'live-url'};
    throw new LinkError('只支持 https://live.kuaishou.com/u/<主播ID>；个人主页、短视频与回放不是直播间');
  }

  if (host === 'livev.m.chenzhongtech.com') {
    const m = /^\/fw\/live\/([0-9A-Za-z_-]{4,40})\/?$/.exec(url.pathname);
    if (m) return {eid: m[1], source: 'h5-share-url'};
    throw new LinkError('H5 分享链接里没有直播间 ID');
  }

  throw new LinkError('不是快手直播链接');
}

export const livePageUrl = (eid) => `https://live.kuaishou.com/u/${encodeURIComponent(eid)}`;
export const h5ShareUrl = (eid) => `https://livev.m.chenzhongtech.com/fw/live/${encodeURIComponent(eid)}`;

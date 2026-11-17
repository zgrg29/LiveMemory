/**
 * Kuaishou test fixtures.
 *
 * Shapes follow the G1/G1.5 research samples:
 *   feed:   {result, cursor, liveStreamFeeds:[{type, content, time, author:{userId,userName}}]}
 *   page:   the SSR room page contains `"playList":[{"liveStream":{"id":"…"}}]` while live.
 *
 * No request is made to Kuaishou: this module only builds JSON/HTML served by a
 * fake `fetch` implementation.
 */

export const KUAISHOU_T0 = 1700000000000;

export function comment({
  userId = 12345,
  userName = '观众A',
  content = '你好',
  time = KUAISHOU_T0 + 123
} = {}) {
  return {type: 'comment', content, time, author: {userId, userName}};
}

export function feed({result = 1, cursor = 'c1', feeds = []} = {}) {
  return {result, cursor, liveStreamFeeds: feeds};
}

export function roomPage({
  eid = 'eid12345',
  liveStreamId = null,
  title = null,
  rateLimited = false,
  generic = false,
  includeEid = true,
  explicitOffline = false
} = {}) {
  const pageTitle = title ?? (generic ? '快手直播' : `${eid} 的直播`);
  const parts = [`<html><head><title>${pageTitle}</title></head><body>`];
  if (rateLimited) parts.push('<div>请求过快，请稍后重试</div>');
  if (includeEid) parts.push(`<script>window.__X={"userId":"${eid}"};</script>`);
  if (liveStreamId) {
    parts.push(`<script>window.__Y={"playList":[{"liveStream":{"id":"${liveStreamId}"}}]};</script>`);
  } else if (explicitOffline) {
    parts.push('<script>window.__Y={"liveStream":null};</script>');
  }
  parts.push('</body></html>');
  return parts.join('');
}

function textResponse(body, status = 200) {
  return {
    status,
    url: 'https://fake.invalid/',
    headers: new Headers(),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

/**
 * Stateful fake fetch.
 *
 * @param {object} options
 * @param {Record<string, object>} options.rooms eid -> {liveStreamId, offline, rateLimited, generic, httpStatus}
 * @param {Record<string, Array<object>>} options.feeds liveStreamId -> sequential feed bodies
 * @param {boolean} options.failFeed throw a network error for every feed request
 * @param {boolean} options.failPages throw a network error for every room page
 */
export function createKuaishouFetch({rooms = {}, feeds = {}, failFeed = false, failPages = false} = {}) {
  const feedCursor = new Map();
  const calls = {pages: [], feeds: []};
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.includes('/u/')) {
      calls.pages.push(text);
      if (failPages) throw Object.assign(new Error('network down'), {name: 'TypeError'});
      const eid = decodeURIComponent((/\/u\/([^/?]+)/.exec(text) ?? [])[1] ?? '');
      const room = rooms[eid];
      if (!room) return textResponse({}, 404);
      if (room.httpStatus && room.httpStatus !== 200) return textResponse('', room.httpStatus);
      return textResponse(roomPage({
        eid,
        liveStreamId: room.liveStreamId ?? null,
        title: room.title ?? null,
        rateLimited: room.rateLimited === true,
        generic: room.generic === true,
        includeEid: room.includeEid !== false,
        explicitOffline: room.explicitOffline === true
      }));
    }
    if (text.includes('/wap/live/feed')) {
      calls.feeds.push(text);
      if (failFeed) throw Object.assign(new Error('network down'), {name: 'TypeError'});
      const liveStreamId = decodeURIComponent((/liveStreamId=([^&]+)/.exec(text) ?? [])[1] ?? '');
      const list = feeds[liveStreamId] ?? [feed({result: 1, cursor: 'c0', feeds: []})];
      const index = feedCursor.get(liveStreamId) ?? 0;
      feedCursor.set(liveStreamId, index + 1);
      return textResponse(list[Math.min(index, list.length - 1)]);
    }
    throw new Error(`unexpected URL in Kuaishou fake: ${text}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

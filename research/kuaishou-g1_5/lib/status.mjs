// Kuaishou G1.5 research prototype — live status detector.
//
// Uses the anonymous `live_api/home/list` snapshot, not the room page SSR.
// Reason: during G1 the SSR page started returning a 57,783-byte
// "请求过快，请稍后重试" shell, and treating "no liveStream.id" as offline would
// have produced false offline signals. A rate-limited list is reported as
// `unknown`, never as `offline`.

import {KuaishouError, CODES, classifyResult} from './errors.mjs';
import {DESKTOP_UA, requestJson} from './http.mjs';

const LIVE_HOST = 'https://live.kuaishou.com';

export function liveHeaders(eid = null) {
  return {
    'user-agent': DESKTOP_UA,
    accept: 'application/json, text/plain, */*',
    referer: eid ? `${LIVE_HOST}/u/${eid}` : `${LIVE_HOST}/`,
    origin: LIVE_HOST
  };
}

/** Tolerant parser for the home list: several nesting shapes have been observed. */
export function parseHomeList(body) {
  const data = body?.data ?? body ?? {};
  const rooms = [];
  const push = (item) => {
    const eid = item?.author?.id ?? item?.author?.principalId ?? null;
    const liveStreamId = item?.liveStream?.id ?? item?.id ?? null;
    if (!eid || !liveStreamId) return;
    rooms.push({
      eid: String(eid),
      liveStreamId: String(liveStreamId),
      caption: item?.caption ?? item?.liveStream?.caption ?? '',
      watchingCount: item?.watchingCount ?? null,
      authorName: item?.author?.name ?? ''
    });
  };
  const sections = Array.isArray(data?.list) ? data.list : [];
  for (const section of sections) {
    for (const group of section?.gameLiveInfo ?? []) {
      for (const item of group?.liveInfo ?? []) push(item);
    }
    for (const item of section?.liveInfo ?? []) push(item);
  }
  for (const item of data?.lives ?? []) push(item);
  for (const item of data?.liveStreams ?? []) push(item);
  return rooms;
}

/**
 * @returns {{state:'live'|'offline'|'rate_limited'|'unknown', liveStreamId?:string,
 *            room?:object, reason?:string, roomsSeen?:number}}
 */
export async function detectLiveStatus(eid, {request = requestJson, timeoutMs = 20000} = {}) {
  let res;
  try {
    res = await request(`${LIVE_HOST}/live_api/home/list`, {
      headers: liveHeaders(),
      timeoutMs
    });
  } catch (err) {
    return {state: 'unknown', reason: err?.code ?? 'NETWORK'};
  }

  const body = res.json ?? {};
  const rawResult = body?.data?.result ?? body?.result;
  // home/list does not always carry a top-level `result`; a present list is a
  // successful response. Only classify when the platform actually sent a code.
  const err = rawResult == null ? null : classifyResult(rawResult, body);
  if (err?.code === CODES.RATE_LIMITED) return {state: 'rate_limited', reason: 'result=2'};
  if (err) return {state: 'unknown', reason: err.code};

  const rooms = parseHomeList(body);
  const found = rooms.find((r) => r.eid === String(eid));
  if (found) return {state: 'live', liveStreamId: found.liveStreamId, room: found, roomsSeen: rooms.length};
  // `home/list` is a rotating recommendation snapshot, not a complete inventory:
  // G1.6 observed 48 different rooms on nearly every request, and rooms that were
  // definitely live were absent from the next snapshot. Absence therefore proves
  // nothing. Only a room-specific response (or a complete inventory) may say
  // `offline`; without one, keep `unknown` so a live room is never reported as
  // ended just because it rotated out of the recommendation list.
  if (rooms.length === 0) return {state: 'unknown', reason: 'EMPTY_LIST', roomsSeen: 0};
  return {state: 'unknown', reason: 'NOT_IN_RECOMMENDATION_SNAPSHOT', roomsSeen: rooms.length};
}

export function assertLive(status) {
  if (status.state === 'live') return status;
  if (status.state === 'offline') {
    throw new KuaishouError(CODES.OFFLINE, '主播当前不在直播', {detail: status});
  }
  if (status.state === 'rate_limited') {
    throw new KuaishouError(CODES.RATE_LIMITED, '直播列表被限流，无法判断是否在播', {detail: status});
  }
  throw new KuaishouError(CODES.UPSTREAM, `无法确认直播状态：${status.reason ?? 'unknown'}`, {detail: status});
}

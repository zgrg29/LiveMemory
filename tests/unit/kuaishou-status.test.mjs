import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROOM_STATUS,
  assertLiveStatus,
  detectKuaishouStatus,
  parseRoomPage
} from '../../src/platforms/kuaishou/status.mjs';
import {KUAISHOU_ERRORS} from '../../src/platforms/kuaishou/errors.mjs';
import {createKuaishouFetch, roomPage} from '../fixtures/kuaishou.mjs';

test('the room page parser separates live, offline, rate-limited and unknown pages', () => {
  const live = parseRoomPage(roomPage({eid: 'e1', liveStreamId: 'L9'}), 'e1');
  assert.equal(live.live, true);
  assert.equal(live.liveStreamId, 'L9');
  assert.equal(live.genericTitle, false);
  assert.equal(live.eidMarker, true);

  const offline = parseRoomPage(roomPage({eid: 'e1'}), 'e1');
  assert.equal(offline.live, false);
  assert.equal(offline.eidMarker, true);
  assert.equal(offline.rateLimited, false);

  const limited = parseRoomPage(roomPage({eid: 'e1', generic: true, rateLimited: true}), 'e1');
  assert.equal(limited.rateLimited, true);
  assert.equal(limited.genericTitle, true);

  const generic = parseRoomPage(roomPage({eid: 'e1', generic: true}), 'e1');
  assert.equal(generic.genericTitle, true);
  assert.equal(generic.eidMarker, true);
});

test('detectKuaishouStatus maps live, offline, rate limit, 404 and unknown without guessing', async () => {
  const rooms = {
    live: {liveStreamId: 'L1', title: '主播的直播'},
    offline: {},
    limited: {rateLimited: true},
    generic: {generic: true}
  };
  const fetchImpl = createKuaishouFetch({rooms});
  const live = await detectKuaishouStatus('live', {fetchImpl, now: () => 1});
  assert.equal(live.state, ROOM_STATUS.LIVE);
  assert.equal(live.liveStreamId, 'L1');
  assert.equal(live.title, '主播的直播');

  const offline = await detectKuaishouStatus('offline', {fetchImpl, now: () => 2});
  assert.equal(offline.state, ROOM_STATUS.OFFLINE);

  const limited = await detectKuaishouStatus('limited', {fetchImpl, now: () => 3});
  assert.equal(limited.state, ROOM_STATUS.RATE_LIMITED);

  const missing = await detectKuaishouStatus('nobody', {fetchImpl, now: () => 4});
  assert.equal(missing.state, ROOM_STATUS.NOT_FOUND);

  const generic = await detectKuaishouStatus('generic', {fetchImpl, now: () => 5});
  assert.equal(generic.state, ROOM_STATUS.UNKNOWN);
  assert.equal(generic.reason, 'GENERIC_PAGE');

  const serverError = await detectKuaishouStatus('error', {
    fetchImpl: createKuaishouFetch({rooms: {error: {httpStatus: 500}}}),
    now: () => 6
  });
  assert.equal(serverError.state, ROOM_STATUS.UNKNOWN);
  assert.equal(serverError.reason, 'HTTP_500');
});

test('an inconclusive or rate-limited page is never treated as offline', async () => {
  const rooms = {
    limited: {rateLimited: true},
    generic: {generic: true},
    offline: {}
  };
  const fetchImpl = createKuaishouFetch({rooms});
  for (const eid of ['limited', 'generic']) {
    const status = await detectKuaishouStatus(eid, {fetchImpl, now: () => 1});
    assert.notEqual(status.state, ROOM_STATUS.OFFLINE, eid);
  }
  const offline = await detectKuaishouStatus('offline', {fetchImpl, now: () => 1});
  assert.equal(offline.state, ROOM_STATUS.OFFLINE);
});

test('assertLiveStatus exposes the exact failure instead of a fake success', () => {
  assert.equal(assertLiveStatus({state: ROOM_STATUS.LIVE, liveStreamId: 'L1'}).liveStreamId, 'L1');
  assert.throws(() => assertLiveStatus({state: ROOM_STATUS.OFFLINE}), (error) => error.code === KUAISHOU_ERRORS.ROOM_OFFLINE);
  assert.throws(() => assertLiveStatus({state: ROOM_STATUS.NOT_FOUND}), (error) => error.code === KUAISHOU_ERRORS.ROOM_NOT_FOUND);
  assert.throws(() => assertLiveStatus({state: ROOM_STATUS.RATE_LIMITED}), (error) => error.code === KUAISHOU_ERRORS.RATE_LIMITED);
  assert.throws(() => assertLiveStatus({state: ROOM_STATUS.UNKNOWN}), (error) => error.code === KUAISHOU_ERRORS.STATUS_UNKNOWN);
});

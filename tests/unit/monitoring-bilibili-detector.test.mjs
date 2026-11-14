import test from 'node:test';
import assert from 'node:assert/strict';
import {BilibiliRoomDetector, parseBilibiliRoomInput} from '../../src/monitoring/detectors/bilibili.mjs';

/** Bilibili detection against a fake HTTP client; no platform request is made. */

function api(overrides = {}) {
  return {
    async roomInit(roomId) {
      return {roomId: Number(roomId) === 12345 ? 987654 : Number(roomId), shortId: Number(roomId), uid: 4242, liveStatus: 1, liveTime: 1234};
    },
    async roomInfo() {
      return {title: 'Room title', areaName: 'Area', parentAreaName: 'Parent', liveStatus: 1, online: 12, anchorName: 'Anchor', anchorUid: 4242};
    },
    async masterInfo() {
      return {name: 'Anchor', uid: 4242};
    },
    async roomStatus() {
      return {roomId: 987654, liveStatus: 1, title: 'Live title', online: 99, liveTime: 1700000000000};
    },
    ...overrides
  };
}

test('Bilibili room input accepts ids and live URLs, resolving short ids', () => {
  assert.equal(parseBilibiliRoomInput('12345').roomId, 12345);
  assert.equal(parseBilibiliRoomInput('https://live.bilibili.com/12345').roomId, 12345);
  assert.equal(parseBilibiliRoomInput('https://live.bilibili.com/blanc/12345?broadcast_type=0').roomId, 12345);
  assert.equal(parseBilibiliRoomInput('live.bilibili.com/12345').roomId, 12345);
  for (const input of ['', 'abc', 'https://example.com/123', 'https://b23.tv/abc', '9999999999999']) {
    assert.throws(() => parseBilibiliRoomInput(input), (error) => error.code === 'MONITOR_INVALID_INPUT', input);
  }
});

test('resolve returns a stable room target with the anchor identity', async () => {
  const detector = new BilibiliRoomDetector({api: api()});
  const target = await detector.resolve('https://live.bilibili.com/12345');
  assert.equal(target.targetKey, '987654');
  assert.equal(target.platformUid, '4242');
  assert.equal(target.broadcasterId, 'bilibili:4242');
  assert.equal(target.displayName, 'Anchor');
  assert.equal(target.meta.shortId, 12345);
  assert.equal(target.meta.areaName, 'Area');
});

test('detect maps live, offline and carousel without inventing an end', async () => {
  const live = new BilibiliRoomDetector({api: api()});
  const liveResult = await live.detect({target_key: '987654'});
  assert.equal(liveResult.status, 'live');
  assert.equal(liveResult.title, 'Live title');
  assert.equal(liveResult.carousel, false);

  const offline = new BilibiliRoomDetector({
    api: api({roomStatus: async () => ({roomId: 987654, liveStatus: 0, title: null, online: null})})
  });
  assert.equal((await offline.detect({target_key: '987654'})).status, 'offline');

  const carousel = new BilibiliRoomDetector({
    api: api({roomStatus: async () => ({roomId: 987654, liveStatus: 2, title: null, online: null})})
  });
  const carouselResult = await carousel.detect({target_key: '987654'});
  assert.equal(carouselResult.status, 'offline');
  assert.equal(carouselResult.carousel, true);
});

test('offline metadata falls back to the public Master endpoint', async () => {
  const detector = new BilibiliRoomDetector({
    api: api({
      roomInfo: async () => {
        throw Object.assign(new Error('risk controlled'), {code: 'PLATFORM'});
      },
      masterInfo: async (uid) => ({name: `Anchor ${uid}`, uid}),
      roomStatus: async () => ({roomId: 987654, liveStatus: 0, title: null, online: null, liveTime: null})
    })
  });
  const target = await detector.resolve('12345');
  assert.equal(target.displayName, 'Anchor 4242');
  assert.equal(target.meta.anchorName, 'Anchor 4242');
  assert.equal(target.broadcasterId, 'bilibili:4242');

  const observation = await detector.detect({
    target_key: '987654',
    display_name: 'Bilibili 987654',
    platform_uid: '4242',
    meta_json: JSON.stringify({})
  });
  assert.equal(observation.status, 'offline');
  assert.equal(observation.anchorName, 'Anchor 4242');
  assert.ok(observation.metadataAttemptedAt > 0);
});

test('detect exposes the platform live start time as a cycle key input', async () => {
  const detector = new BilibiliRoomDetector({api: api()});
  const observation = await detector.detect({target_key: '987654'});
  assert.equal(observation.liveStartedAt, 1700000000000);
});

test('Bilibili errors become stable monitor errors', async () => {
  const rateLimited = new BilibiliRoomDetector({
    api: api({
      roomStatus: async () => {
        throw Object.assign(new Error('risk'), {code: 'PLATFORM', biliCode: -352, status: 200});
      }
    })
  });
  await assert.rejects(
    () => rateLimited.detect({target_key: '987654'}),
    (error) => error.code === 'MONITOR_RATE_LIMITED'
  );

  const notFound = new BilibiliRoomDetector({
    api: api({
      roomInit: async () => {
        throw Object.assign(new Error('missing'), {code: 'ROOM_NOT_FOUND'});
      }
    })
  });
  await assert.rejects(
    () => notFound.resolve('999999'),
    (error) => error.code === 'MONITOR_NOT_FOUND'
  );

  const broken = new BilibiliRoomDetector({
    api: api({
      roomStatus: async () => {
        throw Object.assign(new Error('bad'), {code: 'STATUS_INVALID'});
      }
    })
  });
  await assert.rejects(
    () => broken.detect({target_key: '987654'}),
    (error) => error.code === 'MONITOR_PROTOCOL'
  );

  const network = new BilibiliRoomDetector({
    api: api({
      roomStatus: async () => {
        throw Object.assign(new Error('down'), {code: 'NETWORK'});
      }
    })
  });
  await assert.rejects(
    () => network.detect({target_key: '987654'}),
    (error) => error.code === 'MONITOR_NETWORK'
  );
});

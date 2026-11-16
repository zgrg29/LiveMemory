import test from 'node:test';
import assert from 'node:assert/strict';
import {TikTokClient} from '../../src/platforms/tiktok/client.mjs';

const NOW = 1700000000000;

function jsonResponse(body, {status = 200, headers = {}} = {}) {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
}

function roomPayload({uniqueId = 'creator', roomId = '7700000000000000001', status = 2} = {}) {
  return {
    statusCode: 0,
    data: {
      user: {id: '12345', nickname: 'Creator Name', roomId},
      liveRoom: {status, title: 'Live title', liveRoomStats: {user_count: 12}}
    }
  };
}

test('resolveRoom requests the public api-live endpoint with sourceType=54', async () => {
  let seen = null;
  const client = new TikTokClient({
    now: () => NOW,
    fetchImpl: async (url) => {
      seen = String(url);
      return jsonResponse(roomPayload());
    }
  });
  const room = await client.resolveRoom('@creator');
  assert.ok(seen.startsWith('https://www.tiktok.com/api-live/user/room/?'));
  assert.match(seen, /uniqueId=creator/);
  assert.match(seen, /sourceType=54/);
  assert.equal(room.uniqueId, 'creator');
  assert.equal(room.roomId, '7700000000000000001');
  assert.equal(room.anchorUid, '12345');
  assert.equal(room.anchorName, 'Creator Name');
  assert.equal(room.isLive, true);
  assert.equal(room.title, 'Live title');
});

test('an unknown user maps to TIKTOK_ROOM_NOT_FOUND', async () => {
  const client = new TikTokClient({
    fetchImpl: async () => jsonResponse({statusCode: 19881007, message: 'user_not_found', data: null})
  });
  await assert.rejects(() => client.resolveRoom('nobody'), (error) => error.code === 'TIKTOK_ROOM_NOT_FOUND');
});

test('HTTP 403 and 429 map to a rate-limit error with retry information', async () => {
  for (const status of [403, 429]) {
    const client = new TikTokClient({
      fetchImpl: async () => jsonResponse({}, {status, headers: {'retry-after': '7'}})
    });
    await assert.rejects(() => client.resolveRoom('creator'), (error) => {
      assert.equal(error.code, 'TIKTOK_RATE_LIMITED');
      assert.equal(error.retryAfterMs, 7000);
      return true;
    });
  }
});

test('a network failure maps to TIKTOK_NETWORK instead of a fake offline room', async () => {
  const client = new TikTokClient({
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    }
  });
  await assert.rejects(() => client.resolveRoom('creator'), (error) => error.code === 'TIKTOK_NETWORK');
});

test('fetchRoomInfo parses title, start time, anchor and viewer totals', async () => {
  const client = new TikTokClient({
    now: () => NOW,
    fetchImpl: async () => jsonResponse({
      status_code: 0,
      data: {
        id_str: '7700000000000000001',
        status: 2,
        title: 'A real title',
        create_time: 1700000000,
        owner: {id_str: '12345', nickname: 'Creator Name', unique_id: 'creator'},
        stats: {total_user: 50632651, like_count: 4}
      }
    })
  });
  const info = await client.fetchRoomInfo('7700000000000000001');
  assert.equal(info.roomId, '7700000000000000001');
  assert.equal(info.isLive, true);
  assert.equal(info.title, 'A real title');
  assert.equal(info.startedAt, 1700000000000);
  assert.equal(info.anchorUid, '12345');
  assert.equal(info.anchorName, 'Creator Name');
  assert.equal(info.anchorUniqueId, 'creator');
  assert.equal(info.totalViewers, 50632651);
});

test('the gift catalog is parsed once and cached per room', async () => {
  let calls = 0;
  const client = new TikTokClient({
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({data: {gifts: [
        {id: 56560, name: 'My First Rose', diamond_count: 1, combo: true, type: 1},
        {id: 999, name: 'Big Gift', diamond_count: 100, combo: false, type: 1}
      ]}});
    }
  });
  const first = await client.fetchGiftCatalog('7700000000000000001');
  assert.equal(first.size, 2);
  assert.deepEqual(first.get('56560'), {id: '56560', name: 'My First Rose', diamondCount: 1, combo: true, giftType: 1});
  const second = await client.fetchGiftCatalog('7700000000000000001');
  assert.equal(second, first);
  assert.equal(calls, 1);
});

test('checkRoom keeps a live room live when only room info fails', async () => {
  const client = new TikTokClient({
    now: () => NOW,
    fetchImpl: async (url) => {
      if (String(url).includes('/api-live/user/room/')) return jsonResponse(roomPayload());
      return jsonResponse({status_code: 10011, data: {}}, {status: 200});
    }
  });
  const room = await client.checkRoom('creator');
  assert.equal(room.isLive, true);
  assert.equal(room.roomId, '7700000000000000001');
  assert.equal(room.title, 'Live title');
});

test('an ended room (status 4) is reported as offline', async () => {
  const client = new TikTokClient({
    fetchImpl: async () => jsonResponse(roomPayload({status: 4}))
  });
  const room = await client.resolveRoom('creator');
  assert.equal(room.isLive, false);
  assert.equal(room.status, 4);
});

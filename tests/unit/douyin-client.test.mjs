import test from 'node:test';
import assert from 'node:assert/strict';
import {DouyinWebClient, parseRoomPage} from '../../src/platforms/douyin/client.mjs';

const WEB_RID = '708764876300';
const ROOM_ID = '7708163643157859082';

function escapedPage(overrides = {}) {
  const page = {
    roomStore: {
      roomInfo: {
        room: {
          id_str: ROOM_ID,
          status: 2,
          status_str: '2',
          title: '美好生活，尽在东方甄选',
          user_count_str: '500+',
          ...overrides.room
        }
      }
    },
    roomId: ROOM_ID,
    web_rid: WEB_RID,
    anchor: {id_str: '952641521715660', sec_uid: 'MS4wLjABAAAA-test', nickname: '东方甄选官方旗舰店'},
    ...overrides.top
  };
  return JSON.stringify(page).replace(/"/g, '\\"');
}

function response(body, {status = 200, setCookies = [], contentType = 'text/html; charset=utf-8', headers = {}} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (name.toLowerCase() === 'content-type' ? contentType : headers[name.toLowerCase()] ?? null),
      getSetCookie: () => setCookies
    },
    text: async () => body
  };
}

test('the public page is parsed into room id, live state, title and stable anchor identity', () => {
  const room = parseRoomPage(escapedPage());
  assert.equal(room.webRid, WEB_RID);
  assert.equal(room.roomId, ROOM_ID);
  assert.equal(room.status, 2);
  assert.equal(room.isLive, true);
  assert.equal(room.ended, false);
  assert.equal(room.title, '美好生活，尽在东方甄选');
  assert.equal(room.userCount, '500+');
  assert.equal(room.anchorId, '952641521715660');
  assert.equal(room.anchorName, '东方甄选官方旗舰店');
  assert.equal(room.anchorSecUid, 'MS4wLjABAAAA-test');
});

test('an ended room reports status 4 and is not treated as live', () => {
  const room = parseRoomPage(escapedPage({room: {status: 4}}));
  assert.equal(room.status, 4);
  assert.equal(room.isLive, false);
  assert.equal(room.ended, true);
});

test('a page without any room id is reported as not found, never as live', () => {
  const room = parseRoomPage('<html><body>no live data</body></html>');
  assert.equal(room.roomId, null);
  assert.equal(room.isLive, false);
  assert.equal(room.ended, false);
});

test('fetchRoom keeps the anonymous ttwid cookie and returns the parsed room', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, cookie: options.headers.cookie ?? null});
    return response(escapedPage(), {
      setCookies: [`ttwid=1%7Cabc%7C123; Path=/; Domain=.douyin.com`]
    });
  };
  const client = new DouyinWebClient({fetchImpl, now: () => 1000});
  const room = await client.fetchRoom(WEB_RID);
  assert.equal(room.roomId, ROOM_ID);
  assert.match(client.cookieHeader(), /ttwid=/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://live.douyin.com/${WEB_RID}`);
});

test('the signed WebSocket URL carries room_id, user_unique_id and a non-empty signature', () => {
  const client = new DouyinWebClient({now: () => 1700000000000});
  const target = client.buildWebSocketUrl({roomId: ROOM_ID, cookie: 'ttwid=abc'});
  const url = new URL(target.url);
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.searchParams.get('room_id'), ROOM_ID);
  assert.equal(url.searchParams.get('user_unique_id'), ROOM_ID);
  assert.equal(url.searchParams.get('identity'), 'audience');
  assert.equal(url.searchParams.get('compress'), 'gzip');
  assert.ok((url.searchParams.get('signature') ?? '').length >= 8);
  assert.equal(target.headers.cookie, 'ttwid=abc');
  assert.ok(target.headers['user-agent'].includes('Chrome/'));
});

test('HTTP 429 and 403 become stable Douyin error codes', async () => {
  const rateLimited = new DouyinWebClient({
    fetchImpl: async () => response('slow down', {status: 429})
  });
  await assert.rejects(rateLimited.fetchRoom(WEB_RID), (error) => error.code === 'DOUYIN_RATE_LIMITED');

  const blocked = new DouyinWebClient({
    fetchImpl: async () => response('forbidden', {status: 403})
  });
  await assert.rejects(blocked.fetchRoom(WEB_RID), (error) => error.code === 'DOUYIN_BLOCKED');

  const missing = new DouyinWebClient({
    fetchImpl: async () => response('no', {status: 404})
  });
  await assert.rejects(missing.fetchRoom(WEB_RID), (error) => error.code === 'DOUYIN_ROOM_NOT_FOUND');
});

test('a risk-control page is reported as blocked, not as a missing room', async () => {
  const client = new DouyinWebClient({
    fetchImpl: async () => response('<html>安全验证 请完成验证</html>')
  });
  await assert.rejects(client.fetchRoom(WEB_RID), (error) => (
    error.code === 'DOUYIN_BLOCKED' && error.details?.blocked === true
  ));
});

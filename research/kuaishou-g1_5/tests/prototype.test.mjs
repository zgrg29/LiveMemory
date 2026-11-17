import test from 'node:test';
import assert from 'node:assert/strict';

import {parseRoomInput, LinkError} from '../lib/link.mjs';
import {encodeBytes, encodeString, encodeUInt, decodeFields, readString} from '../lib/protobuf.mjs';
import {
  decodeEnvelope, decodeFeedPush, encodeEnvelope, encodeEnterRoom, encodeHeartbeat,
  encodeUserExit
} from '../lib/ws-protocol.mjs';
import {createNormalizer, NAMESPACE, qualifyUid} from '../lib/normalize.mjs';
import {IdentityRegistry} from '../lib/identity.mjs';
import {parseHomeList, detectLiveStatus} from '../lib/status.mjs';
import {AnonymousH5Transport, H5_POLICY} from '../lib/h5-transport.mjs';
import {AuthenticatedWebSocketTransport} from '../lib/ws-transport.mjs';
import {CODES, classifyResult} from '../lib/errors.mjs';

test('link: accepts live room inputs and rejects non-live pages', () => {
  assert.deepEqual(parseRoomInput('https://live.kuaishou.com/u/abc12345'), {eid: 'abc12345', source: 'live-url'});
  assert.deepEqual(parseRoomInput('https://livev.m.chenzhongtech.com/fw/live/abc12345'), {eid: 'abc12345', source: 'h5-share-url'});
  assert.deepEqual(parseRoomInput('3xtgiecv6inq83i'), {eid: '3xtgiecv6inq83i', source: 'bare-id'});
  assert.throws(() => parseRoomInput('https://www.kuaishou.com/short-video/3xabc'), LinkError);
  assert.throws(() => parseRoomInput('https://live.kuaishou.com/profile/3xabc'), LinkError);
  assert.throws(() => parseRoomInput('https://example.com/u/1'), LinkError);
  assert.throws(() => parseRoomInput(''), LinkError);
});

test('protobuf: varint/string fields decode as written', () => {
  const bytes = Buffer.concat([encodeString(1, 'K1'), encodeUInt(2, 300), encodeBytes(3, Buffer.from([1, 2, 3]))]);
  const fields = decodeFields(bytes);
  assert.equal(readString(fields, 1), 'K1');
  assert.deepEqual([...fields.get(3)[0]], [1, 2, 3]);
});

test('ws protocol: envelope + enter room + feed push', () => {
  const enter = encodeEnterRoom({token: 't0', liveStreamId: 'L1', reconnectCount: 2});
  const env = decodeEnvelope(enter);
  assert.equal(env.type, 'CS_ENTER_ROOM');
  const inner = decodeFields(env.payload);
  assert.equal(readString(inner, 1), 't0');
  assert.equal(readString(inner, 2), 'L1');
  assert.equal(decodeEnvelope(encodeHeartbeat(123)).type, 'CS_HEARTBEAT');
  assert.equal(decodeEnvelope(encodeUserExit(123)).type, 'CS_USER_EXIT');

  const user = Buffer.concat([encodeString(1, 'u-1'), encodeString(2, '小明'), encodeString(3, 'https://a/b.png')]);
  const comment = Buffer.concat([
    encodeString(1, 'feed-1'),
    encodeBytes(2, user),
    encodeString(3, '你好'),
    encodeUInt(9, 1700000000123)
  ]);
  const giftUser = Buffer.concat([encodeString(1, 'u-2'), encodeString(2, 'giver')]);
  const gift = Buffer.concat([
    encodeString(1, 'gift-1'),
    encodeBytes(2, giftUser),
    encodeUInt(3, 1700000000456),
    encodeUInt(4, 88),
    encodeUInt(7, 3)
  ]);
  const push = Buffer.concat([
    encodeString(1, '42'),
    encodeBytes(5, comment),
    encodeBytes(9, gift)
  ]);
  const decoded = decodeEnvelope(encodeEnvelope(310, push));
  assert.equal(decoded.type, 'SC_FEED_PUSH');
  const feed = decodeFeedPush(decoded.payload);
  assert.equal(feed.watchingCount, '42');
  assert.equal(feed.comments.length, 1);
  assert.equal(feed.comments[0].id, 'feed-1');
  assert.equal(feed.comments[0].user.principalId, 'u-1');
  assert.equal(feed.comments[0].user.nickname, '小明');
  assert.equal(feed.comments[0].content, '你好');
  assert.equal(feed.comments[0].time, 1700000000123);
  assert.equal(feed.gifts[0].giftId, '88');
  assert.equal(feed.gifts[0].count, 3);
});

test('normalizer: canonical chat keeps namespaced identity and original text', () => {
  const n = createNormalizer({namespace: NAMESPACE.H5, sessionId: 's1', roomId: 'eid1', liveStreamId: 'L1'});
  const chat = n.chat({id: 'c1', principalId: '12345', nickname: '观众A', content: '原文 🎉', time: 1700000000000}, 1700000000100);
  assert.equal(chat.platform, 'kuaishou');
  assert.equal(chat.event_type, 'chat');
  assert.equal(chat.viewer_uid, 'h5:12345');
  assert.equal(chat.viewer_id, 'kuaishou:h5:12345');
  assert.equal(chat.external_id, 'h5:c1');
  assert.equal(chat.content, '原文 🎉');
  assert.equal(chat.source_quality, 'unknown');
  assert.equal(chat.dedupe_key, 'ext:h5:c1');

  const noId = n.chat({principalId: null, nickname: '匿名', content: 'x', time: 1700000000000}, 1700000000000);
  assert.equal(noId.viewer_uid, null);
  assert.equal(noId.viewer_id, null);
  assert.match(noId.dedupe_key, /^fp:/);

  const gift = n.gift({id: 'g1', principalId: '9', nickname: 'g', giftId: '88', giftName: '棒棒糖', count: 2, time: 1700000000000}, 1700000000000);
  assert.equal(gift.event_type, 'gift');
  assert.equal(gift.amount_minor, null);
  assert.equal(gift.currency, null);
  assert.equal(gift.value_kind, 'unknown');
  assert.equal(gift.gift_quantity, 2);
  assert.equal(gift.viewer_uid, 'h5:9');
});

test('identity: namespaces stay isolated until explicit evidence links them', () => {
  const reg = new IdentityRegistry();
  for (const room of ['A', 'B']) {
    reg.observe({namespace: NAMESPACE.H5, rawUid: '777', nickname: '同名', room});
  }
  reg.observe({namespace: NAMESPACE.WS, rawUid: '777', nickname: '同名', room: 'A'});
  reg.observe({namespace: NAMESPACE.H5, rawUid: null, nickname: '无ID', room: 'A'});

  const stats = reg.stats();
  assert.equal(stats.byNamespace.h5.distinctIds, 1);
  assert.equal(stats.byNamespace.h5.missingIds, 1);
  assert.equal(stats.byNamespace.h5.idsSeenInMoreThanOneRoom, 1);
  assert.equal(stats.byNamespace.ws.distinctIds, 1);
  assert.equal(stats.linkedPairs, 0);
  assert.equal(stats.crossRouteMerge, 'not-established');

  assert.equal(reg.canMerge(NAMESPACE.H5, '777', NAMESPACE.WS, '777'), false);
  assert.throws(() => reg.link({h5Uid: '777', wsUid: '777', evidence: {}}), /证据/);
  reg.link({h5Uid: '777', wsUid: '777', evidence: {kind: 'operator-self-sent-comment', at: '2026-11-17'}});
  assert.equal(reg.canMerge(NAMESPACE.H5, '777', NAMESPACE.WS, '777'), true);
  assert.equal(qualifyUid(NAMESPACE.H5, '0'), null);
});

test('status: home list parsing and rate-limit is never offline', async () => {
  const body = {
    data: {
      result: 1,
      list: [{gameLiveInfo: [{liveInfo: [{author: {id: 'eid1', name: '主播'}, liveStream: {id: 'L9'}, caption: '标题', watchingCount: 12}]}]}]
    }
  };
  assert.equal(parseHomeList(body).length, 1);
  assert.equal(parseHomeList(body)[0].liveStreamId, 'L9');

  const live = await detectLiveStatus('eid1', {request: async () => ({json: body})});
  assert.equal(live.state, 'live');
  assert.equal(live.liveStreamId, 'L9');

  // G1.6 regression: `home/list` rotates, so absence is not proof of offline.
  const absent = await detectLiveStatus('eid2', {request: async () => ({json: body})});
  assert.equal(absent.state, 'unknown');
  assert.equal(absent.reason, 'NOT_IN_RECOMMENDATION_SNAPSHOT');

  const limited = await detectLiveStatus('eid1', {request: async () => ({json: {data: {result: 2}}})});
  assert.equal(limited.state, 'rate_limited');

  const empty = await detectLiveStatus('eid1', {request: async () => ({json: {data: {result: 1, list: []}}})});
  assert.equal(empty.state, 'unknown');
  assert.equal(empty.reason, 'EMPTY_LIST');

  // Regression: home/list can omit `result` entirely; a present list is success.
  const noResult = {data: {list: [{gameLiveInfo: [{liveInfo: [{author: {id: 'eid9'}, liveStream: {id: 'L7'}}]}]}]}};
  const stillLive = await detectLiveStatus('eid9', {request: async () => ({json: noResult})});
  assert.equal(stillLive.state, 'live');
  assert.equal(stillLive.liveStreamId, 'L7');
});

test('h5 transport: refuses to run without the policy acknowledgement', () => {
  assert.equal(H5_POLICY.blocked, true);
  assert.throws(() => new AnonymousH5Transport({eid: 'e', liveStreamId: 'L'}), (err) => err.code === CODES.POLICY_BLOCKED);
});

test('h5 transport: dedupes a replayed batch and ends on result 601', async () => {
  let call = 0;
  const responses = [
    {result: 1, cursor: 'c1', liveStreamFeeds: [
      {type: 'comment', content: 'hi', time: 1000, author: {userId: 77, userName: 'a'}},
      {type: 'comment', content: 'hi', time: 1000, author: {userId: 77, userName: 'a'}}
    ]},
    {result: 1, cursor: 'c1', liveStreamFeeds: [
      {type: 'comment', content: 'hi', time: 1000, author: {userId: 77, userName: 'a'}}
    ]},
    {result: 601, error_msg: '直播已停止'}
  ];
  const fetchImpl = async () => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {ok: true, status: 200, text: async () => JSON.stringify(body)};
  };
  const t = new AnonymousH5Transport({eid: 'e', liveStreamId: 'L', acknowledgePolicy: true, fetchImpl, intervalMs: 1, now: () => 1});
  const batches = [];
  const states = [];
  const stats = await t.start({onEvents: (b) => batches.push(b), onStatus: (s) => states.push(s.state)});
  assert.equal(stats.messages, 1);
  assert.equal(stats.duplicates, 2);
  assert.equal(t.state, 'ended');
  assert.equal(batches.length, 1);
  assert.ok(states.includes('ended'));
});

test('ws transport: connects, acks heartbeat, normalizes real-shaped frames, reconnects once', async () => {
  const ack = encodeEnvelope(300, encodeUInt(3, 20000));
  const feed = (() => {
    const user = Buffer.concat([encodeString(1, 'u-9'), encodeString(2, '观众')]);
    const comment = Buffer.concat([encodeString(1, 'c-9'), encodeBytes(2, user), encodeString(3, '弹幕'), encodeUInt(9, 1700000000000)]);
    const gift = Buffer.concat([encodeString(1, 'g-9'), encodeBytes(2, user), encodeUInt(3, 1700000000001), encodeUInt(4, 5), encodeUInt(7, 1)]);
    return encodeEnvelope(310, Buffer.concat([encodeBytes(5, comment), encodeBytes(9, gift)]));
  })();

  let sockets = 0;
  class FakeSocket {
    constructor() {
      this.listeners = new Map();
      this.sent = [];
      this.binaryType = 'arraybuffer';
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    emit(type, event = {}) {
      for (const fn of this.listeners.get(type) ?? []) fn(event);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.emit('close', {code: 1000, reason: 'test'});
    }
  }
  const factory = () => {
    const socket = new FakeSocket();
    sockets += 1;
    setTimeout(() => {
      socket.emit('open');
      setTimeout(() => {
        socket.emit('message', {data: ack});
        socket.emit('message', {data: feed});
        setTimeout(() => socket.emit('close', {code: 1000}), 5);
      }, 1);
    }, 1);
    return socket;
  };

  const normalizer = createNormalizer({namespace: NAMESPACE.WS, sessionId: 's', roomId: 'e', liveStreamId: 'L'});
  const transport = new AuthenticatedWebSocketTransport({
    normalizer, urls: ['wss://example.invalid/ws'], token: 't', liveStreamId: 'L',
    socketFactory: factory, maxReconnects: 1
  });
  const events = [];
  const statuses = [];
  await assert.rejects(
    () => transport.start({onEvents: (b) => events.push(...b), onStatus: (s) => statuses.push(s.state)}),
    (err) => err.code === CODES.NETWORK
  );

  assert.equal(events.length, 2);
  assert.equal(events[0].event_type, 'chat');
  assert.equal(events[0].viewer_uid, 'ws:u-9');
  assert.equal(events[0].external_id, 'ws:c-9');
  assert.equal(events[1].event_type, 'gift');
  assert.equal(events[1].amount_minor, null);
  assert.equal(transport.stats.comments, 1);
  assert.equal(transport.stats.gifts, 1);
  assert.equal(transport.stats.heartbeatIntervalMs, 20000);
  assert.equal(transport.stats.connections, 2);
  assert.ok(statuses.includes('connected'));
});

test('error taxonomy: result codes are classified, unknown stays upstream', () => {
  assert.equal(classifyResult(601).code, CODES.OFFLINE);
  assert.equal(classifyResult(2).code, CODES.RATE_LIMITED);
  assert.equal(classifyResult(109).code, CODES.AUTH_REQUIRED);
  assert.equal(classifyResult(999).code, CODES.UPSTREAM);
  assert.equal(classifyResult(1), null);
});

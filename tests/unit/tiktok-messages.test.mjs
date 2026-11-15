import test from 'node:test';
import assert from 'node:assert/strict';
import {readFields, encodeBytesField, encodeVarintField, readVarint, writeVarint} from '../../src/platforms/tiktok/protobuf.mjs';
import {decodeFetchResult, decodeWebcastResponse, mapTikTokMessage} from '../../src/platforms/tiktok/messages.mjs';
import {
  chatMessage,
  controlMessage,
  fetchResult,
  giftMessage,
  likeMessage,
  memberMessage,
  roomUserSeqMessage,
  socialMessage,
  webcastResponse
} from '../helpers/tiktok-frames.mjs';

const NOW = 1700000005000;

test('the protobuf codec reads varints, nested messages and unknown fields', () => {
  const nested = Buffer.concat([encodeBytesField(1, 'nested'), encodeVarintField(2, 7n)]);
  const buffer = Buffer.concat([
    encodeVarintField(1, 300n),
    encodeBytesField(2, nested),
    encodeVarintField(99, 5n)
  ]);
  const fields = readFields(buffer);
  assert.equal(fields.length, 3);
  assert.equal(fields[0].value, 300n);
  assert.equal(fields[1].bytes.toString('utf8'), nested.toString('utf8'));
  assert.equal(fields[2].field, 99);
});

test('truncated and malformed buffers raise TIKTOK_PROTOCOL instead of guessing', () => {
  assert.throws(() => readFields(Buffer.from([0x0a, 0x05, 0x61])), (error) => error.code === 'TIKTOK_PROTOCOL');
  assert.throws(() => readFields(Buffer.from([0x00])), (error) => error.code === 'TIKTOK_PROTOCOL');
  assert.equal(writeVarint(300n).toString('hex'), 'ac02');
  assert.equal(readVarint(Buffer.from([0xac, 0x02]), 0).value, 300n);
});

test('decodes a fetch result envelope: cursor, internalExt, ws url and route params', () => {
  const buffer = fetchResult({
    messages: [{method: 'WebcastChatMessage', payload: chatMessage(), msgId: 1001n}],
    cursor: 'cursor-abc',
    internalExt: 'fetch_time:1|seq:2',
    routeParams: [['X-Bogus', 'b1'], ['wrss', 'w1']]
  });
  const decoded = decodeFetchResult(buffer);
  assert.equal(decoded.cursor, 'cursor-abc');
  assert.equal(decoded.internalExt, 'fetch_time:1|seq:2');
  assert.equal(decoded.messages.length, 1);
  assert.equal(decoded.messages[0].method, 'WebcastChatMessage');
  assert.equal(decoded.messages[0].envelopeMsgId, '1001');
  assert.equal(decoded.routeParams.get('X-Bogus'), 'b1');
  assert.equal(decoded.pushServer, 'wss://webcast-ws.example/webcast/im/ws_proxy/');
});

test('a chat message maps to a verified canonical event with a stable user id', () => {
  const decoded = decodeFetchResult(fetchResult({
    messages: [{method: 'WebcastChatMessage', payload: chatMessage({msgId: '123456', userId: '4242', nickname: 'Alice', content: 'hello 🌍 你好'})}]
  }));
  const mapped = mapTikTokMessage(decoded.messages[0], {now: NOW});
  assert.equal(mapped.kind, 'event');
  const event = mapped.event;
  assert.equal(event.event_type, 'chat');
  assert.equal(event.viewer_uid, '4242');
  assert.equal(event.display_name, 'Alice');
  assert.equal(event.content, 'hello 🌍 你好');
  assert.equal(event.external_id, '123456');
  assert.equal(event.occurred_at, 1700000000000);
  assert.equal(event.source_quality, 'verified');
  assert.equal(event.is_paid, false);
  assert.equal(event.amount_minor, null);
  assert.equal(event.value_kind, 'unknown');
});

test('an emoji-only chat keeps the original text and is not dropped', () => {
  const decoded = decodeFetchResult(fetchResult({
    messages: [{method: 'WebcastChatMessage', payload: chatMessage({content: '😁😊🥺🙂🤩🤠😭'})}]
  }));
  const mapped = mapTikTokMessage(decoded.messages[0], {now: NOW});
  assert.equal(mapped.kind, 'event');
  assert.equal(mapped.event.content, '😁😊🥺🙂🤩🤠😭');
});

test('a gift maps diamonds as a display value and never as income', () => {
  const decoded = decodeFetchResult(fetchResult({
    messages: [{method: 'WebcastGiftMessage', payload: giftMessage({giftName: 'Rose', diamonds: 5, repeatCount: 3, repeatEnd: 1})}]
  }));
  const mapped = mapTikTokMessage(decoded.messages[0], {now: NOW});
  assert.equal(mapped.kind, 'gift');
  assert.equal(mapped.final, true);
  const event = mapped.event;
  assert.equal(event.event_type, 'gift');
  assert.equal(event.viewer_uid, '4242');
  assert.equal(event.gift_id, '56560');
  assert.equal(event.gift_name, 'Rose');
  assert.equal(event.gift_quantity, 3);
  assert.equal(event.amount_minor, null);
  assert.equal(event.currency, null);
  assert.equal(event.value_kind, 'unknown');
  assert.equal(event.amount_display, '15 TikTok Diamonds');
  // Gift semantics are parsed, but a real gift event has not been observed yet.
  assert.equal(event.source_quality, 'estimated');
});

test('a gift without a diamond count makes no amount up and can fall back to the catalog', () => {
  const decoded = decodeFetchResult(fetchResult({
    messages: [{method: 'WebcastGiftMessage', payload: giftMessage({diamonds: 0, giftName: ''})}]
  }));
  const catalog = new Map([['56560', {id: '56560', name: 'My First Rose', diamondCount: 1}]]);
  const mapped = mapTikTokMessage(decoded.messages[0], {giftCatalog: catalog, now: NOW});
  assert.equal(mapped.event.gift_name, 'My First Rose');
  assert.equal(mapped.event.amount_display, '1 TikTok Diamonds');
});

test('member, like and social messages are counted but never written as events', () => {
  for (const [method, payload, counter] of [
    ['WebcastMemberMessage', memberMessage(), 'member'],
    ['WebcastLikeMessage', likeMessage(), 'like'],
    ['WebcastSocialMessage', socialMessage(), 'social']
  ]) {
    const mapped = mapTikTokMessage({method, payload}, {now: NOW});
    assert.equal(mapped.kind, 'ignored', method);
    assert.equal(mapped.counter, counter);
  }
});

test('viewer counts and control messages are observations, not events', () => {
  const viewers = mapTikTokMessage({method: 'WebcastRoomUserSeqMessage', payload: roomUserSeqMessage({viewerCount: 321})}, {now: NOW});
  assert.deepEqual(viewers, {kind: 'viewers', viewerCount: 321});
  const control = mapTikTokMessage({method: 'WebcastControlMessage', payload: controlMessage({action: 3})}, {now: NOW});
  assert.deepEqual(control, {kind: 'control', action: 3});
});

test('unknown and empty payloads are ignored instead of guessed', () => {
  assert.equal(mapTikTokMessage({method: 'WebcastSomethingNew', payload: Buffer.from([0x08, 0x01])}, {now: NOW}).kind, 'ignored');
  assert.equal(mapTikTokMessage({method: 'WebcastChatMessage', payload: Buffer.alloc(0)}, {now: NOW}).kind, 'ignored');
  assert.equal(mapTikTokMessage({method: 'WebcastChatMessage', payload: chatMessage({content: ''})}, {now: NOW}).kind, 'ignored');
});

test('the classic WebSocket envelope decodes too (browser relay path)', () => {
  const buffer = webcastResponse({
    messages: [{method: 'WebcastChatMessage', payload: chatMessage({msgId: '9001'}), msgId: 9001n}],
    cursor: 'ws-cursor'
  });
  const decoded = decodeWebcastResponse(buffer);
  assert.equal(decoded.cursor, 'ws-cursor');
  assert.equal(decoded.messages.length, 1);
  assert.equal(decoded.messages[0].envelopeMsgId, '9001');
  const mapped = mapTikTokMessage(decoded.messages[0], {now: NOW});
  assert.equal(mapped.kind, 'event');
});

test('a chat message without a platform id still yields a deterministic dedupe fingerprint', async () => {
  const {buildDedupeKey} = await import('../../src/shared/events.mjs');
  const decoded = decodeFetchResult(fetchResult({
    messages: [{method: 'WebcastChatMessage', payload: chatMessage({msgId: null})}]
  }));
  const mapped = mapTikTokMessage(decoded.messages[0], {now: NOW});
  const key = buildDedupeKey({...mapped.event, platform: 'tiktok'});
  assert.match(key, /^fp:/);
  const again = buildDedupeKey({...mapTikTokMessage(decoded.messages[0], {now: NOW}).event, platform: 'tiktok'});
  assert.equal(key, again);
});

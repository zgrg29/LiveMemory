import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeMessage, encodeMessage, MESSAGE_SCHEMAS, bigintText} from '../../src/platforms/douyin/protobuf.mjs';
import {chatBody, giftBody, pushFrame, chatMessage} from '../helpers/douyin-frames.mjs';
import {decodeFrame, decodeMessageBody, GiftComboTracker, mapDouyinMessage, METHOD} from '../../src/platforms/douyin/messages.mjs';

test('a chat body round-trips nickname, Unicode text and a 19-digit user id without precision loss', () => {
  const payload = chatBody({
    msgId: '7000000000000000001',
    userId: '952641521715660',
    name: '观众😀',
    content: '你好 世界 😂 [比心]',
    createTime: 1700000000
  });
  const body = decodeMessage(payload, MESSAGE_SCHEMAS.ChatMessage);
  assert.equal(bigintText(body.user.id), '952641521715660');
  assert.equal(body.user.nickName, '观众😀');
  assert.equal(body.content, '你好 世界 😂 [比心]');
  assert.equal(bigintText(body.common.msgId), '7000000000000000001');
  assert.equal(bigintText(body.common.createTime), '1700000000');
});

test('unknown fields are skipped instead of corrupting the known ones', () => {
  const known = encodeMessage({content: 'hello', user: {nickName: 'A'}}, {
    2: {name: 'user', type: 'message:User'},
    3: {name: 'content', type: 'string'}
  });
  const unknown = encodeMessage({value: 12345n}, {999: {name: 'value', type: 'uint64'}});
  const merged = Buffer.concat([known, unknown]);
  const body = decodeMessage(merged, MESSAGE_SCHEMAS.ChatMessage);
  assert.equal(body.content, 'hello');
  assert.equal(body.user.nickName, 'A');
});

test('a truncated varint or length is reported as a protocol error instead of a partial message', () => {
  assert.throws(() => decodeMessage(Buffer.from([0x1a, 0x7f]), MESSAGE_SCHEMAS.ChatMessage));
});

test('a gzip push frame decodes into messages and ack metadata', () => {
  const frame = pushFrame([chatMessage('11', {content: 'hi'})], {needAck: true, internalExt: 'ext-1'});
  const decoded = decodeFrame(frame);
  assert.equal(decoded.payloadType, 'msg');
  assert.equal(decoded.needAck, true);
  assert.equal(decoded.internalExt, 'ext-1');
  assert.equal(decoded.messages.length, 1);
  assert.equal(decoded.messages[0].method, METHOD.CHAT);
  assert.equal(decoded.messages[0].msgId, '11');
});

test('an uncompressed frame is accepted too', () => {
  const frame = pushFrame([chatMessage('12', {content: 'plain'})], {gzip: false});
  const decoded = decodeFrame(frame);
  assert.equal(decoded.messages.length, 1);
  assert.equal(decodeMessageBody(METHOD.CHAT, decoded.messages[0].payload).content, 'plain');
});

test('chat mapping never substitutes a nickname for the stable user id', () => {
  const withId = decodeMessageBody(METHOD.CHAT, chatBody({msgId: '2', userId: '12345', name: 'A', content: 'x'}));
  const mapped = mapDouyinMessage({method: METHOD.CHAT, msgId: '2', body: withId, receivedAt: 1700000000123});
  assert.equal(mapped.kind, 'chat');
  assert.equal(mapped.draft.viewer_uid, '12345');
  assert.equal(mapped.draft.display_name, 'A');
  assert.equal(mapped.draft.external_id, '2');
  assert.equal(mapped.draft.content, 'x');
  assert.equal(mapped.draft.source_quality, 'verified');

  const withoutId = decodeMessageBody(METHOD.CHAT, chatBody({msgId: '3', userId: '0', name: 'NoId', content: 'y'}));
  const anonymous = mapDouyinMessage({method: METHOD.CHAT, msgId: '3', body: withoutId, receivedAt: 1700000000123});
  assert.equal(anonymous.draft.viewer_uid, null);
  assert.equal(anonymous.draft.display_name, 'NoId');
  assert.equal(anonymous.draft.source_quality, 'unknown');
});

test('member, like and follow events are counted but never become paid gifts', () => {
  assert.equal(mapDouyinMessage({method: METHOD.LIKE, msgId: '6', body: {}, receivedAt: 1}).draft, null);
  assert.equal(mapDouyinMessage({method: METHOD.MEMBER, msgId: '5', body: {}, receivedAt: 1}).kind, 'member');
  assert.equal(mapDouyinMessage({method: METHOD.SOCIAL, msgId: '7', body: {}, receivedAt: 1}).kind, 'follow');
  const mapped = mapDouyinMessage({method: METHOD.CHAT, msgId: 'x', body: null, receivedAt: 1});
  assert.equal(mapped.draft, null);
});

test('a gift combo writes one final event and never counts the intermediate steps twice', () => {
  const tracker = new GiftComboTracker({now: () => 1000});
  const first = decodeMessageBody(METHOD.GIFT, giftBody({msgId: '21', repeatCount: 1, repeatEnd: 0, groupId: '77'}));
  const second = decodeMessageBody(METHOD.GIFT, giftBody({msgId: '22', repeatCount: 2, repeatEnd: 0, groupId: '77'}));
  const final = decodeMessageBody(METHOD.GIFT, giftBody({msgId: '23', repeatCount: 3, repeatEnd: 1, groupId: '77'}));

  assert.equal(tracker.ingest(first, {receivedAt: 1000}).pending, true);
  assert.equal(tracker.ingest(second, {receivedAt: 1100}).pending, true);
  const done = tracker.ingest(final, {receivedAt: 1200, msgId: '23'});
  assert.equal(done.pending, false);
  assert.equal(done.draft.gift_quantity, 3);
  assert.equal(done.draft.gift_name, 'Rose');
  assert.equal(done.draft.gift_id, '500');
  assert.equal(done.draft.viewer_uid, '1001');
  assert.equal(done.draft.external_id, '23');
  assert.equal(done.draft.amount_minor, null);
  assert.equal(done.draft.currency, null);
  assert.equal(done.draft.value_kind, 'unknown');
  assert.equal(done.draft.is_paid, true);
  assert.equal(done.draft.amount_display, '3 抖音币');
  assert.equal(tracker.pending.size, 0, 'a finalized combo is not re-emitted');
  assert.equal(tracker.ingest(final, {receivedAt: 1300, msgId: '23'}).pending, false);
});

test('a gift without a platform diamond value keeps the amount unknown instead of zero', () => {
  const tracker = new GiftComboTracker({now: () => 1000});
  const body = decodeMessageBody(METHOD.GIFT, giftBody({diamondCount: 0, repeatEnd: 1, repeatCount: 1}));
  const result = tracker.ingest(body, {receivedAt: 1000, msgId: '30'});
  assert.equal(result.draft.amount_minor, null);
  assert.equal(result.draft.amount_display, null);
  assert.equal(result.draft.value_kind, 'unknown');
});

test('an unfinished combo is dropped after the TTL instead of being guessed into a gift', () => {
  const tracker = new GiftComboTracker({ttlMs: 1000, now: () => 0});
  tracker.ingest(decodeMessageBody(METHOD.GIFT, giftBody({repeatEnd: 0, groupId: '5'})), {receivedAt: 0});
  assert.equal(tracker.pending.size, 1);
  tracker.ingest(decodeMessageBody(METHOD.GIFT, giftBody({repeatEnd: 0, groupId: '6'})), {receivedAt: 5000});
  assert.equal(tracker.pending.size, 1);
  assert.equal(tracker.stats.dropped, 1);
  assert.equal(tracker.clear().dropped, 1);
});

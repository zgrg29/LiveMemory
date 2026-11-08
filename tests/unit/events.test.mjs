import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDedupeKey,
  buildViewerId,
  isMessageEvent,
  isPaymentEvent,
  normalizeEvent
} from '../../src/shared/events.mjs';

const base = {
  platform: 'bilibili',
  event_type: 'chat',
  session_id: 'ses_test',
  viewer_uid: 12345,
  display_name: ' 星野つき ',
  occurred_at: '2026-11-08T10:00:00.000Z',
  content: '  こんばんは  ',
  external_id: 'msg-1'
};

test('normalizes a chat event into the canonical model', () => {
  const event = normalizeEvent(base, {now: 1000});
  assert.equal(event.platform, 'bilibili');
  assert.equal(event.event_type, 'chat');
  assert.equal(event.viewer_uid, '12345');
  assert.equal(event.viewer_id, 'bilibili:12345');
  assert.equal(event.display_name, '星野つき');
  assert.equal(event.content, 'こんばんは');
  assert.equal(event.occurred_at, Date.parse('2026-11-08T10:00:00.000Z'));
  assert.equal(event.received_at, 1000);
  assert.equal(event.is_paid, false);
  assert.equal(event.amount_minor, null);
  assert.equal(event.source_quality, 'unknown');
  assert.equal(event.dedupe_key, 'ext:msg-1');
});

test('viewer identity is namespaced per platform and never derived from a nickname', () => {
  assert.equal(buildViewerId('bilibili', '42'), 'bilibili:42');
  assert.equal(buildViewerId('youtube', 'UC123'), 'youtube:UC123');
  assert.equal(buildViewerId('bilibili', ''), null);
  assert.equal(buildViewerId('bilibili', null), null);
  const a = normalizeEvent({...base, platform: 'bilibili'}, {now: 1000});
  const b = normalizeEvent({...base, platform: 'youtube', external_id: 'msg-2'}, {now: 1000});
  assert.notEqual(a.viewer_id, b.viewer_id);
});

test('gift amount is derived from unit price and quantity without float drift', () => {
  const event = normalizeEvent({
    ...base,
    event_type: 'gift',
    gift_id: 'g1',
    gift_name: '棒棒糖',
    gift_type: 'paid',
    gift_quantity: 3,
    unit_amount_minor: 100,
    currency: 'CNY'
  }, {now: 1000});
  assert.equal(event.amount_minor, 300);
  assert.equal(event.gift_quantity, 3);
  assert.equal(event.is_paid, true);
  assert.equal(event.value_kind, 'actual');
});

test('free gifts stay uncharged and unknown amounts stay unknown', () => {
  const free = normalizeEvent({...base, event_type: 'gift', gift_type: 'free', unit_amount_minor: 0, currency: 'CNY'}, {now: 1});
  assert.equal(free.amount_minor, 0);
  assert.equal(free.is_paid, false);
  assert.equal(free.value_kind, 'unknown');

  const unknown = normalizeEvent({...base, event_type: 'gift', gift_name: '谜之礼物'}, {now: 1});
  assert.equal(unknown.amount_minor, null);
  assert.equal(unknown.value_kind, 'unknown');
});

test('paid event types default to paid, chat defaults to free', () => {
  assert.equal(isMessageEvent('chat'), true);
  assert.equal(isMessageEvent('super_chat'), true);
  assert.equal(isMessageEvent('gift'), false);
  assert.equal(isPaymentEvent('gift'), true);
  assert.equal(isPaymentEvent('super_chat'), true);
  assert.equal(isPaymentEvent('chat'), false);
  assert.equal(normalizeEvent({...base, event_type: 'super_chat', amount_minor: 5000}, {now: 1}).is_paid, true);
  assert.equal(normalizeEvent({...base, event_type: 'guard', amount_minor: 13800}, {now: 1}).is_paid, true);
});

test('event_type aliases and timestamps in seconds are accepted', () => {
  const event = normalizeEvent({
    platform: 'youtube',
    eventType: 'chat',
    sessionId: 'ses_x',
    occurredAt: 1_700_000_000,
    receivedAt: 1_700_000_100,
    viewerUid: 'UC1',
    displayName: 'Viewer',
    content: 'hi',
    externalId: 'yt-1'
  }, {now: 5});
  assert.equal(event.event_type, 'chat');
  assert.equal(event.occurred_at, 1_700_000_000_000);
  assert.equal(event.received_at, 1_700_000_100_000);
  assert.equal(event.dedupe_key, 'ext:yt-1');
});

test('events without a stable user id still normalize, but have no viewer id', () => {
  const event = normalizeEvent({...base, viewer_uid: ''}, {now: 1});
  assert.equal(event.viewer_uid, null);
  assert.equal(event.viewer_id, null);
});

test('dedupe falls back to a deterministic fingerprint', () => {
  const event = normalizeEvent({...base, external_id: null}, {now: 1});
  assert.match(event.dedupe_key, /^fp:[0-9a-f]{32}$/);
  const again = normalizeEvent({...base, external_id: null}, {now: 1});
  assert.equal(event.dedupe_key, again.dedupe_key);
  const different = normalizeEvent({...base, external_id: null, content: '别的消息'}, {now: 1});
  assert.notEqual(event.dedupe_key, different.dedupe_key);
});

test('invalid drafts are rejected with a stable error code', () => {
  assert.throws(() => normalizeEvent({...base, event_type: 'nope'}), /EVENT_INVALID/);
  assert.throws(() => normalizeEvent({...base, platform: 'BAD PLATFORM'}), /EVENT_INVALID/);
  assert.throws(() => normalizeEvent({...base, session_id: null}), /EVENT_INVALID/);
  assert.throws(() => normalizeEvent(null), /EVENT_INVALID/);
});

test('over-long chat content is truncated instead of rejected', () => {
  const event = normalizeEvent({...base, content: 'x'.repeat(5000)}, {now: 1});
  assert.equal(event.content.length, 4000);
});

test('dedupe key builder is stable for an event object', () => {
  const event = normalizeEvent(base, {now: 1});
  assert.equal(buildDedupeKey(event), event.dedupe_key);
});

test('canonical events keep normalized emote metadata and include it in the fingerprint', () => {
  const withEmote = normalizeEvent({
    ...base,
    external_id: null,
    content: '今天这个剧情太好笑了😂',
    emotes: [
      {id: 'room_5050_cat', code: '[猫猫鼓掌]', name: '猫猫鼓掌', source: 'bilibili.info13'},
      {id: 'room_5050_cat', name: 'duplicate should be dropped'},
      {name: ''}
    ]
  }, {now: 1});
  assert.deepEqual(withEmote.emotes, [{
    id: 'room_5050_cat',
    code: '[猫猫鼓掌]',
    name: '猫猫鼓掌',
    source: 'bilibili.info13'
  }]);
  const withoutEmote = normalizeEvent({...base, external_id: null, content: '今天这个剧情太好笑了😂'}, {now: 1});
  assert.notEqual(withEmote.dedupe_key, withoutEmote.dedupe_key);
  assert.match(withEmote.dedupe_key, /^fp:[0-9a-f]{32}$/);
});

test('emote metadata is only attached to message events', () => {
  const gift = normalizeEvent({
    ...base,
    event_type: 'gift',
    gift_name: '礼物',
    emotes: [{id: 'x', name: 'x'}]
  }, {now: 1});
  assert.equal(gift.emotes, null);
});

test('over-long emoji text is truncated on a grapheme boundary', () => {
  const family = '👨‍👩‍👧‍👦';
  const event = normalizeEvent({...base, content: `${'a'.repeat(3998)}${family}`}, {now: 1});
  assert.ok(event.content.isWellFormed());
  assert.ok(!event.content.endsWith('\u200D'));
  assert.ok(event.content.length <= 4000);
  assert.equal(event.content, 'a'.repeat(3998), 'the full family emoji does not fit');
});

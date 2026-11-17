import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeJwtPayload,
  extractPublication,
  kickEventKind,
  mapKickBadges,
  mapKickChatEvent,
  mapKickEvent,
  mapKickGiftEvent,
  mapKickGiftedSubscriptions,
  parseKickEmotes,
  parseKickTimestamp,
  splitFrameText
} from '../../src/platforms/kick/messages.mjs';
import {kickChat, publicationFrame, KICK_TEST_CHATROOM} from '../helpers/kick-frames.mjs';

const ROOM = {slug: 'odablock', channelId: '2401072', chatroomId: String(KICK_TEST_CHATROOM)};
const RECEIVED = 1794849900000;

test('a real-shaped chat message maps to a verified canonical draft', () => {
  const {draft, reason} = mapKickChatEvent(kickChat(), {sessionId: 'session-1', room: ROOM, receivedAt: RECEIVED});
  assert.equal(reason, null);
  assert.equal(draft.session_id, 'session-1');
  assert.equal(draft.platform, 'kick');
  assert.equal(draft.event_type, 'chat');
  assert.equal(draft.external_id, 'afc48273-912e-4c11-a32a-57e4b692423c');
  assert.equal(draft.viewer_uid, '3119475', 'numeric sender id is a string uid');
  assert.equal(draft.display_name, 'Alice');
  assert.equal(draft.content, 'hello world');
  assert.equal(draft.occurred_at, Date.parse('2026-11-16T17:23:46+00:00'));
  assert.equal(draft.received_at, RECEIVED);
  assert.equal(draft.source_quality, 'verified');
  assert.deepEqual(draft.badges, [{type: 'member', label: 'Subscriber'}]);
  assert.equal(draft._kick.chatroomId, String(KICK_TEST_CHATROOM));
  assert.equal(draft._kick.timestampSource, 'created_at');
});

test('emote markers are parsed but the raw content is never rewritten', () => {
  const content = '[emote:5216699:gregYikes] play [emote:37230:POLICE] now';
  const {draft} = mapKickChatEvent(kickChat({content}), {sessionId: 's', room: ROOM, receivedAt: RECEIVED});
  assert.equal(draft.content, content);
  assert.deepEqual(draft.emotes, [
    {id: '5216699', name: 'gregYikes', source: 'kick'},
    {id: '37230', name: 'POLICE', source: 'kick'}
  ]);
  assert.equal(parseKickEmotes('[emote:1:ok]').length, 1);
  assert.equal(parseKickEmotes('no emotes here'), null);
  // The same emote repeated is de-duplicated in metadata, not in content.
  const repeated = '[emote:1:ok][emote:1:ok][emote:1:ok]';
  assert.equal(parseKickEmotes(repeated).length, 1);
  assert.equal(mapKickChatEvent(kickChat({content: repeated}), {room: ROOM, receivedAt: RECEIVED}).draft.content, repeated);
});

test('CJK text and Unicode emoji are preserved byte for byte', () => {
  const content = '你好 こんにちは 안녕하세요 🌏🎉 [emote:9:pepe]';
  const {draft} = mapKickChatEvent(kickChat({content}), {room: ROOM, receivedAt: RECEIVED});
  assert.equal(draft.content, content);
  assert.equal(draft.emotes.length, 1);
});

test('reply messages keep the parent id as diagnostics without changing identity', () => {
  const chat = kickChat({
    type: 'reply',
    metadata: {
      original_sender: {id: 30528864, username: 'Gwniron'},
      original_message: {id: '37e49060-67a9-482f-8244-a0b6826e3e2b', content: 'I hate greg'}
    },
    thread_parent_id: '37e49060-67a9-482f-8244-a0b6826e3e2b'
  });
  const {draft} = mapKickChatEvent(chat, {room: ROOM, receivedAt: RECEIVED});
  assert.equal(draft.viewer_uid, '3119475');
  assert.equal(draft._kick.messageType, 'reply');
  assert.equal(draft._kick.replyTo, '37e49060-67a9-482f-8244-a0b6826e3e2b');
});

test('a missing sender id degrades to no identity instead of a fake one', () => {
  const chat = kickChat({sender: {id: null, username: 'Anon', slug: 'anon', identity: {badges: []}}});
  const {draft} = mapKickChatEvent(chat, {room: ROOM, receivedAt: RECEIVED});
  assert.ok(draft, 'the message is still recorded');
  assert.equal(draft.viewer_uid, null);
  assert.equal(draft.display_name, 'Anon');
  assert.equal(draft.source_quality, 'unknown');
});

test('a missing username or content is rejected rather than invented', () => {
  const noName = mapKickChatEvent(kickChat({sender: {id: 5}}), {room: ROOM, receivedAt: RECEIVED});
  assert.equal(noName.draft, null);
  assert.equal(noName.reason, 'username_missing');
  const noContent = mapKickChatEvent(kickChat({content: undefined}), {room: ROOM, receivedAt: RECEIVED});
  assert.equal(noContent.draft, null);
  assert.equal(noContent.reason, 'content_missing');
});

test('a missing message id leaves external_id null so dedupe falls back to a fingerprint', () => {
  const {draft} = mapKickChatEvent(kickChat({id: undefined}), {room: ROOM, receivedAt: RECEIVED});
  assert.equal(draft.external_id, null);
  assert.equal(draft.source_quality, 'unknown');
  assert.equal(draft._kick.timestampSource, 'created_at');
});

test('timestamps without an offset are treated as UTC and flagged', () => {
  const {draft} = mapKickChatEvent(kickChat({created_at: '2026-11-16 17:23:46'}), {room: ROOM, receivedAt: RECEIVED});
  assert.equal(draft.occurred_at, Date.UTC(2026, 10, 16, 17, 23, 46));
  assert.equal(draft._kick.assumedUtc, true);
  assert.equal(parseKickTimestamp('not a date').ms, null);
});

test('an unparsable timestamp falls back to received time and says so', () => {
  const {draft} = mapKickChatEvent(kickChat({created_at: 'yesterday'}), {room: ROOM, receivedAt: RECEIVED});
  assert.equal(draft.occurred_at, RECEIVED);
  assert.equal(draft._kick.timestampSource, 'received_at');
  assert.equal(draft.source_quality, 'unknown');
});

test('badges map to the small canonical set; labels stay platform text', () => {
  assert.deepEqual(
    mapKickBadges({badges: [
      {type: 'subscriber', text: 'Subscriber'},
      {type: 'moderator', text: 'Moderator'},
      {type: 'broadcaster', text: 'Broadcaster'},
      {type: 'verified', text: 'Verified'},
      {type: 'mystery', text: 'Mystery'}
    ]}),
    [
      {type: 'member', label: 'Subscriber'},
      {type: 'moderator', label: 'Moderator'},
      {type: 'owner', label: 'Broadcaster'},
      {type: 'verified', label: 'Verified'},
      {type: 'unknown', label: 'Mystery'}
    ]
  );
  assert.equal(mapKickBadges({}), null);
  assert.equal(mapKickBadges({badges: 'nope'}), null);
});

test('batched frames and wrapped publications are decoded', () => {
  const frame = publicationFrame('App\\Events\\ChatMessageEvent', kickChat());
  const parts = splitFrameText(`${JSON.stringify(frame)}\n${JSON.stringify({id: 2, subscribe: {}})}`);
  assert.equal(parts.length, 2);
  const publication = extractPublication(frame.push);
  assert.equal(publication.channel, `chatrooms.${KICK_TEST_CHATROOM}.v2`);
  assert.equal(publication.event, 'App\\Events\\ChatMessageEvent');
  assert.equal(publication.data.sender.username, 'Alice');

  const arrayPush = {channel: 'chatrooms.1.v2', pubs: [{data: {event: 'X', data: '{"a":1}'}}]};
  assert.deepEqual(extractPublication(arrayPush).data, {a: 1});
  assert.equal(extractPublication({pub: {data: {event: 'X', data: '{broken'}}}).decodeFailed, true);
  assert.equal(extractPublication({}), null);
});

test('event names classify without inventing events', () => {
  assert.equal(kickEventKind('App\\Events\\ChatMessageEvent'), 'chat');
  assert.equal(kickEventKind('App\\Events\\SubscriptionEvent'), 'subscription');
  assert.equal(kickEventKind('App\\Events\\GiftedSubscriptionsEvent'), 'gifted_subscriptions');
  assert.equal(kickEventKind('App\\Events\\KicksGifted'), 'kicks_gifted');
  // Four of Kick's five chat feeds publish unprefixed names.
  assert.equal(kickEventKind('GiftedSubscriptionsEvent'), 'gifted_subscriptions');
  assert.equal(kickEventKind('KicksGifted'), 'kicks_gifted');
  assert.equal(kickEventKind('RewardRedeemedEvent'), 'reward_redemption');
  assert.equal(kickEventKind('StreamHostedEvent'), 'host');
  assert.equal(kickEventKind('App\\Events\\SomethingNew'), 'unknown');
});

test('the guest JWT payload is readable without trusting the signature', () => {
  const token = 'a.eyJzdWIiOiJndWVzdDoxIiwiZXhwIjoxNzk0ODUyMzgwLCJpYXQiOjE3OTQ4NDk2ODB9.c';
  assert.deepEqual(decodeJwtPayload(token), {sub: 'guest:1', exp: 1794852380, iat: 1794849680});
  assert.equal(decodeJwtPayload('not-a-jwt'), null);
  assert.equal(decodeJwtPayload(null), null);
});

const GIFT = {
  gift_transaction_id: '8805437e-e571-4ce1-a30b-ca177ebd4936',
  message: '',
  sender: {id: 21608659, username: 'Gifter', username_color: '#E4D88F'},
  gift: {gift_id: 'full_send', name: 'Full Send', amount: 100, type: 'BASIC', tier: 'BASIC'},
  created_at: '2026-11-16T17:58:56.976408449Z'
};

test('a KICKs gift keeps its transaction id, sender id and KICKs count but no fiat value', () => {
  const {drafts, kind} = mapKickEvent('KicksGifted', GIFT, {sessionId: 's', room: ROOM, receivedAt: RECEIVED});
  assert.equal(kind, 'kicks_gifted');
  assert.equal(drafts.length, 1);
  const gift = drafts[0];
  assert.equal(gift.event_type, 'gift');
  assert.equal(gift.external_id, GIFT.gift_transaction_id);
  assert.equal(gift.viewer_uid, '21608659');
  assert.equal(gift.display_name, 'Gifter');
  assert.equal(gift.gift_id, 'full_send');
  assert.equal(gift.gift_name, 'Full Send');
  assert.equal(gift.gift_quantity, 1);
  assert.equal(gift.amount_minor, null);
  assert.equal(gift.currency, null);
  assert.equal(gift.value_kind, 'unknown');
  assert.equal(gift.is_paid, true);
  assert.equal(gift.amount_display, '100 KICKs · BASIC/BASIC');
  assert.equal(gift.occurred_at, Date.parse('2026-11-16T17:58:56.976408449Z'));
  assert.equal(gift.source_quality, 'verified');
});

test('a gift without a sender id is still recorded but gets no identity', () => {
  const {drafts} = mapKickGiftEvent({...GIFT, sender: {username: 'Anon'}}, {room: ROOM, receivedAt: RECEIVED});
  assert.equal(drafts[0].viewer_uid, null);
  assert.equal(drafts[0].source_quality, 'unknown');
});

test('gifted subscriptions keep the recipients as free events and the gifter as one paid event', () => {
  const data = {
    chatroom_id: 2393554,
    correlation_id: 'corr-1',
    gifted_usernames: ['one', 'two', 'three'],
    gifter_username: 'Generous',
    gifted_total: 3,
    gifter_total: 36,
    chunk_details: null
  };
  const {drafts} = mapKickGiftedSubscriptions(data, {sessionId: 's', room: ROOM, receivedAt: RECEIVED});
  assert.equal(drafts.length, 4);
  const gifter = drafts[0];
  assert.equal(gifter.event_type, 'membership');
  assert.equal(gifter.external_id, 'corr-1');
  assert.equal(gifter.display_name, 'Generous');
  assert.equal(gifter.gift_quantity, 3);
  assert.equal(gifter.is_paid, true);
  assert.equal(gifter.amount_minor, null);
  const recipients = drafts.slice(1);
  assert.deepEqual(recipients.map((draft) => draft.display_name), ['one', 'two', 'three']);
  assert.deepEqual(recipients.map((draft) => draft.external_id), ['corr-1:recipient:0', 'corr-1:recipient:1', 'corr-1:recipient:2']);
  assert.ok(recipients.every((draft) => draft.is_paid === false && draft.viewer_uid === null));
  assert.ok(recipients.every((draft) => draft.source_quality === 'verified'));
});

test('gifted subscriptions without correlation ids still dedupe deterministically', () => {
  const data = {gifted_usernames: ['a', 'b'], gifter_username: 'G', gifted_total: 2};
  const first = mapKickGiftedSubscriptions(data, {room: ROOM, receivedAt: 1}).drafts.map((draft) => draft.external_id);
  const second = mapKickGiftedSubscriptions(data, {room: ROOM, receivedAt: 2}).drafts.map((draft) => draft.external_id);
  assert.deepEqual(first, second);
});

test('subscription and unsupported events are classified, not invented', () => {
  const sub = mapKickEvent('App\\Events\\SubscriptionEvent', {username: 'Subber', months: 3}, {room: ROOM, receivedAt: RECEIVED});
  assert.equal(sub.kind, 'subscription');
  assert.equal(sub.drafts[0].event_type, 'membership');
  assert.equal(sub.drafts[0].display_name, 'Subber');
  assert.equal(sub.drafts[0].viewer_uid, null);
  assert.equal(sub.drafts[0].amount_display, '3 mo');

  const ban = mapKickEvent('App\\Events\\UserBannedEvent', {id: 'x'}, {room: ROOM, receivedAt: RECEIVED});
  assert.deepEqual(ban.drafts, []);
  assert.equal(ban.reason, 'unsupported_event');
  assert.equal(ban.kind, 'user_banned');

  const unknown = mapKickEvent('App\\Events\\SomethingNew', {}, {room: ROOM, receivedAt: RECEIVED});
  assert.deepEqual(unknown.drafts, []);
  assert.equal(unknown.reason, 'unknown_event');
});

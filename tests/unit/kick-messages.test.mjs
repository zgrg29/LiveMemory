import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeJwtPayload,
  extractPublication,
  kickEventKind,
  mapKickBadges,
  mapKickChatEvent,
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

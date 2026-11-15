import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIrcLine} from '../../src/platforms/twitch/irc.mjs';
import {
  mapTwitchPrivmsg,
  mapTwitchRoomState,
  mapTwitchUsernotice,
  subscriptionPlanLabel
} from '../../src/platforms/twitch/mapper.mjs';

function tagsText(tags) {
  return Object.entries(tags)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\:').replace(/ /g, '\\s')}`)
    .join(';');
}

function privmsg(tags, text) {
  return parseIrcLine(`@${tagsText(tags)} :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #channel :${text}`);
}

function usernotice(tags, text = '') {
  return parseIrcLine(`@${tagsText(tags)} :tmi.twitch.tv USERNOTICE #channel${text ? ` :${text}` : ''}`);
}

const BASE_TAGS = {
  'display-name': 'Alice',
  'user-id': '1001',
  login: 'alice',
  id: 'msg-1',
  'room-id': '42',
  'tmi-sent-ts': '1700000000123',
  badges: 'moderator/1,subscriber/12',
  'badge-info': 'subscriber/12'
};

test('a normal PRIVMSG keeps stable identity, message id, time and Unicode text', () => {
  const draft = mapTwitchPrivmsg(privmsg({...BASE_TAGS, emotes: '25:0-4'}, 'Hello 世界 😂 :wave:'));
  assert.equal(draft.platform, 'twitch');
  assert.equal(draft.event_type, 'chat');
  assert.equal(draft.viewer_uid, '1001');
  assert.equal(draft.display_name, 'Alice');
  assert.equal(draft.external_id, 'msg-1');
  assert.equal(draft.occurred_at, 1700000000123);
  assert.equal(draft.content, 'Hello 世界 😂 :wave:');
  assert.equal(draft.source_quality, 'verified');
  assert.equal(draft.identity_complete, true);
  assert.equal(draft.emotes[0].id, '25');
  assert.equal(draft.badges[0].type, 'moderator');
  assert.equal(draft.is_paid, false);
});

test('a missing user-id is never replaced by the nickname', () => {
  const draft = mapTwitchPrivmsg(privmsg({'display-name': 'NoId', login: 'noid', id: 'm2', 'tmi-sent-ts': '1'}, 'hi'));
  assert.equal(draft.viewer_uid, null);
  assert.equal(draft.display_name, 'NoId');
  assert.equal(draft.identity_complete, false);
});

test('a Bits Cheer becomes a paid super_chat with a count but no fiat amount', () => {
  const draft = mapTwitchPrivmsg(privmsg({...BASE_TAGS, bits: '500', id: 'cheer-1'}, 'cheer500 great stream'));
  assert.equal(draft.event_type, 'super_chat');
  assert.equal(draft.is_paid, true);
  assert.equal(draft.gift_id, 'twitch-bits');
  assert.equal(draft.gift_name, 'Bits');
  assert.equal(draft.gift_quantity, 500);
  assert.equal(draft.amount_minor, null);
  assert.equal(draft.currency, null);
  assert.equal(draft.value_kind, 'unknown');
  assert.equal(draft.amount_display, '500 Bits');
  assert.equal(draft.content, 'cheer500 great stream');
  assert.equal(draft.source_quality, 'estimated');
});

test('resub carries tier, months and the user message without inventing money', () => {
  const draft = mapTwitchUsernotice(usernotice({
    ...BASE_TAGS,
    id: 'notice-1',
    'msg-id': 'resub',
    'msg-param-sub-plan': '1000',
    'msg-param-cumulative-months': '12'
  }, 'thanks for the stream'));
  assert.equal(draft.event_type, 'membership');
  assert.equal(draft.viewer_uid, '1001');
  assert.equal(draft.content, 'thanks for the stream');
  assert.equal(draft.gift_name, 'Subscription · Tier 1');
  assert.equal(draft.amount_display, '12 months');
  assert.equal(draft.gift_quantity, 1);
  assert.equal(draft.amount_minor, null);
  assert.equal(draft.value_kind, 'unknown');
  assert.equal(draft.is_paid, true);
  assert.equal(draft.source_quality, 'verified');
});

test('Prime and unknown plans are labelled honestly', () => {
  assert.equal(subscriptionPlanLabel('Prime'), 'Prime');
  assert.equal(subscriptionPlanLabel('2000'), 'Tier 2');
  assert.equal(subscriptionPlanLabel('3'), 'Tier 3');
  assert.equal(subscriptionPlanLabel('special'), 'Plan special');
});

test('a new subscription is marked estimated because it was not observed live', () => {
  const draft = mapTwitchUsernotice(usernotice({
    ...BASE_TAGS,
    id: 'notice-2',
    'msg-id': 'sub',
    'msg-param-sub-plan': 'Prime'
  }));
  assert.equal(draft.event_type, 'membership');
  assert.equal(draft.gift_name, 'Subscription · Prime');
  assert.equal(draft.source_quality, 'estimated');
});

test('a gifted subscription counts the gifter once and keeps the recipient as display detail', () => {
  const draft = mapTwitchUsernotice(usernotice({
    ...BASE_TAGS,
    id: 'notice-3',
    'msg-id': 'subgift',
    'msg-param-sub-plan': '2000',
    'msg-param-recipient-id': '2002',
    'msg-param-recipient-display-name': 'Bob',
    'msg-param-months': '1'
  }));
  assert.equal(draft.event_type, 'gift');
  assert.equal(draft.viewer_uid, '1001');
  assert.equal(draft.display_name, 'Alice');
  assert.equal(draft.gift_quantity, 1);
  assert.equal(draft.gift_name, 'Gifted subscription · Tier 2');
  assert.equal(draft.amount_display, 'to Bob · 1 month');
  assert.equal(draft.amount_minor, null);
  assert.equal(draft.value_kind, 'unknown');
  assert.equal(draft.is_paid, true);
  assert.equal(draft.source_quality, 'estimated');
});

test('the submysterygift total is skipped so subgift events are not double counted', () => {
  assert.equal(mapTwitchUsernotice(usernotice({
    ...BASE_TAGS,
    id: 'notice-4',
    'msg-id': 'submysterygift',
    'msg-param-mass-gift-count': '5'
  })), null);
});

test('viewer milestones and unknown notices are not turned into chat or payments', () => {
  assert.equal(mapTwitchUsernotice(usernotice({
    ...BASE_TAGS,
    id: 'notice-5',
    'msg-id': 'viewermilestone'
  })), null);
  assert.equal(mapTwitchUsernotice(usernotice({
    ...BASE_TAGS,
    id: 'notice-6',
    'msg-id': 'something-new'
  })), null);
});

test('ROOMSTATE exposes the stable broadcaster room id', () => {
  const parsed = parseIrcLine('@room-id=71092938;slow=0 :tmi.twitch.tv ROOMSTATE #xqc');
  assert.deepEqual(mapTwitchRoomState(parsed), {roomId: '71092938', channel: 'xqc'});
});

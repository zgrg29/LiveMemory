import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractYouTubeEmoteCodes,
  mapYouTubeChatMessage,
  microsToMinor,
  isKnownYouTubeEvent,
  IGNORED_YOUTUBE_EVENTS,
  YOUTUBE_MAPPER_STATUS
} from '../../src/platforms/youtube/mapper.mjs';

const RECEIVED = 1_700_000_000_000;

function message(overrides = {}) {
  return {
    kind: 'youtube#liveChatMessage',
    id: overrides.id ?? 'msg-1',
    snippet: {
      type: 'textMessageEvent',
      liveChatId: 'live-chat-1',
      authorChannelId: {value: 'UC_VIEWER_1'},
      publishedAt: '2023-11-14T22:13:20.000Z',
      displayMessage: 'hello',
      textMessageDetails: {messageText: 'hello'},
      ...overrides.snippet
    },
    authorDetails: {
      channelId: 'UC_VIEWER_1',
      displayName: 'YouTube Viewer',
      ...overrides.authorDetails
    }
  };
}

test('YouTube mapper documents its own verification status', () => {
  assert.equal(YOUTUBE_MAPPER_STATUS, 'unverified');
});

test('plain YouTube chat keeps Unicode emoji and the stable channel id', () => {
  const mapped = mapYouTubeChatMessage(message({
    snippet: {
      displayMessage: '今日は楽しい😂❤️',
      textMessageDetails: {messageText: '今日は楽しい😂❤️'}
    }
  }), {receivedAt: RECEIVED});
  assert.equal(mapped.platform, 'youtube');
  assert.equal(mapped.event_type, 'chat');
  assert.equal(mapped.content, '今日は楽しい😂❤️');
  assert.equal(mapped.viewer_uid, 'UC_VIEWER_1');
  assert.equal(mapped.display_name, 'YouTube Viewer');
  assert.equal(mapped.external_id, 'msg-1');
  // Official fields, but not yet observed in a real broadcast of this project.
  assert.equal(mapped.source_quality, 'estimated');
  assert.equal(mapped.identity_complete, true);
  assert.equal(mapped.verified, false);
  assert.equal(mapped.occurred_at, Date.parse('2023-11-14T22:13:20.000Z'));
});

test('custom YouTube emote codes are preserved as codes, never resolved to an invented image', () => {
  const mapped = mapYouTubeChatMessage(message({
    snippet: {
      displayMessage: 'that was great :face-blue-smiling: 😂',
      textMessageDetails: {messageText: 'that was great :face-blue-smiling: 😂'}
    }
  }), {receivedAt: RECEIVED});
  assert.equal(mapped.content, 'that was great :face-blue-smiling: 😂');
  assert.deepEqual(mapped.emotes, [{
    code: ':face-blue-smiling:',
    name: 'face-blue-smiling',
    source: 'youtube.messageText'
  }]);
});

test('emote code extraction does not misread URLs or clock times', () => {
  assert.deepEqual(extractYouTubeEmoteCodes('see https://example.com/a:b and 12:30 now'), []);
  assert.deepEqual(extractYouTubeEmoteCodes('hello :face-blue-smiling: world'), [{
    code: ':face-blue-smiling:',
    name: 'face-blue-smiling',
    source: 'youtube.messageText'
  }]);
});

test('an emote-only YouTube message is kept with the original text', () => {
  const mapped = mapYouTubeChatMessage(message({
    snippet: {
      displayMessage: ':face-blue-smiling:',
      textMessageDetails: {messageText: ':face-blue-smiling:'}
    }
  }), {receivedAt: RECEIVED});
  assert.equal(mapped.content, ':face-blue-smiling:');
  assert.equal(mapped.emotes.length, 1);
});

test('without a channel id the event is recorded but identity stays incomplete', () => {
  const mapped = mapYouTubeChatMessage(message({
    snippet: {authorChannelId: null},
    authorDetails: {channelId: null, displayName: 'Anon'}
  }), {receivedAt: RECEIVED});
  assert.equal(mapped.viewer_uid, null);
  assert.equal(mapped.identity_complete, false);
  assert.equal(mapped.source_quality, 'estimated');
});

test('a nickname alone never becomes an identity', () => {
  const mapped = mapYouTubeChatMessage(message({
    snippet: {authorChannelId: undefined},
    authorDetails: {channelId: undefined, displayName: 'Same Name'}
  }), {receivedAt: RECEIVED});
  assert.equal(mapped.viewer_uid, null);
  assert.equal(mapped.display_name, 'Same Name');
  assert.equal(mapped.identity_complete, false);
});

/* ------------------------------------------------------------- Super Chat -- */

test('Super Chat keeps the payer, exact amount, currency and comment', () => {
  const mapped = mapYouTubeChatMessage(message({
    id: 'sc-1',
    snippet: {
      type: 'superChatEvent',
      displayMessage: 'Great stream',
      superChatDetails: {
        amountMicros: '5000000',
        currency: 'USD',
        amountDisplayString: '$5.00',
        userComment: 'Great stream',
        tier: 2
      }
    }
  }), {receivedAt: RECEIVED});
  assert.equal(mapped.event_type, 'super_chat');
  assert.equal(mapped.viewer_uid, 'UC_VIEWER_1');
  assert.equal(mapped.content, 'Great stream');
  assert.equal(mapped.amount_minor, 500);
  assert.equal(mapped.currency, 'USD');
  assert.equal(mapped.value_kind, 'actual');
  assert.equal(mapped.is_paid, true);
  assert.equal(mapped.external_id, 'sc-1');
  // A Super Chat is also a message in the timeline.
  assert.equal(mapped.event_type, 'super_chat');
});

test('Super Chat currencies are never converted: JPY stays whole yen', () => {
  const mapped = mapYouTubeChatMessage(message({
    snippet: {
      type: 'superChatEvent',
      superChatDetails: {amountMicros: '1500000000', currency: 'JPY', userComment: 'ありがとう'}
    }
  }), {receivedAt: RECEIVED});
  assert.equal(mapped.currency, 'JPY');
  assert.equal(mapped.amount_minor, 1500);
});

test('micros convert to integer minor units without floating point drift', () => {
  assert.equal(microsToMinor('1000000', 'USD'), 100);
  assert.equal(microsToMinor('1', 'USD'), 0);
  assert.equal(microsToMinor('5000', 'USD'), 1); // 0.005 rounds up to 1 cent
  assert.equal(microsToMinor('4999', 'USD'), 0);
  assert.equal(microsToMinor('1500000000', 'JPY'), 1500);
  assert.equal(microsToMinor('199990000', 'AUD'), 19999);
  assert.equal(microsToMinor(null, 'USD'), null);
  assert.equal(microsToMinor('not-a-number', 'USD'), null);
  assert.equal(microsToMinor('-5', 'USD'), null);
});

/* ---------------------------------------------------------- Super Sticker -- */

test('Super Sticker keeps the payer, amount and sticker identity even without text', () => {
  const mapped = mapYouTubeChatMessage(message({
    id: 'sticker-1',
    snippet: {
      type: 'superStickerEvent',
      displayMessage: '',
      superStickerDetails: {
        amountMicros: '2000000',
        currency: 'EUR',
        amountDisplayString: '€2.00',
        tier: 1,
        superStickerMetadata: {stickerId: 'abc123', altText: 'cheering cat', language: 'en'}
      }
    }
  }), {receivedAt: RECEIVED});
  assert.equal(mapped.event_type, 'super_sticker');
  assert.equal(mapped.content, null);
  assert.equal(mapped.gift_id, 'abc123');
  assert.equal(mapped.gift_name, 'cheering cat');
  assert.equal(mapped.amount_minor, 200);
  assert.equal(mapped.currency, 'EUR');
  assert.equal(mapped.viewer_uid, 'UC_VIEWER_1');
  assert.equal(mapped.is_paid, true);
});

/* -------------------------------------------------------------- membership -- */

test('a new membership records the level but never invents a price', () => {
  const mapped = mapYouTubeChatMessage(message({
    id: 'member-1',
    snippet: {
      type: 'newSponsorEvent',
      newSponsorDetails: {memberLevelName: 'Tier 1', isUpgrade: false}
    }
  }), {receivedAt: RECEIVED});
  assert.equal(mapped.event_type, 'membership');
  assert.equal(mapped.gift_name, 'Tier 1');
  assert.equal(mapped.amount_minor, null);
  assert.equal(mapped.currency, null);
  assert.equal(mapped.value_kind, 'unknown');
  assert.equal(mapped.membership.kind, 'new');
});

test('a membership milestone keeps the comment and the month count', () => {
  const mapped = mapYouTubeChatMessage(message({
    id: 'milestone-1',
    snippet: {
      type: 'memberMilestoneChatEvent',
      memberMilestoneChatDetails: {
        userComment: '6 months already 😂',
        memberLevelName: 'Tier 2',
        memberMonth: 6
      }
    }
  }), {receivedAt: RECEIVED});
  assert.equal(mapped.event_type, 'membership');
  assert.equal(mapped.content, '6 months already 😂');
  assert.equal(mapped.gift_name, 'Tier 2');
  assert.equal(mapped.gift_id, 'membership-month:6');
  assert.equal(mapped.membership.month, 6);
  assert.equal(mapped.amount_minor, null);
});

test('gifted memberships record the count for the gifter', () => {
  const mapped = mapYouTubeChatMessage(message({
    id: 'gifting-1',
    snippet: {
      type: 'membershipGiftingEvent',
      membershipGiftingDetails: {giftMembershipsCount: 5, giftMembershipsLevelName: 'Tier 1'}
    }
  }), {receivedAt: RECEIVED});
  assert.equal(mapped.event_type, 'membership');
  assert.equal(mapped.gift_quantity, 5);
  assert.equal(mapped.gift_name, 'Tier 1');
  assert.equal(mapped.membership.kind, 'gifting');
  assert.equal(mapped.membership.count, 5);
  assert.equal(mapped.amount_minor, null);
});

test('a received gifted membership is never counted as a payment by the recipient', () => {
  const mapped = mapYouTubeChatMessage(message({
    id: 'received-1',
    snippet: {
      type: 'giftMembershipReceivedEvent',
      giftMembershipReceivedDetails: {
        memberLevelName: 'Tier 1',
        gifterChannelId: 'UC_GIFTER',
        associatedMembershipGiftingMessageId: 'gifting-1'
      }
    }
  }), {receivedAt: RECEIVED});
  assert.equal(mapped.event_type, 'membership');
  assert.equal(mapped.is_paid, false);
  assert.equal(mapped.gift_type, 'free');
  assert.equal(mapped.amount_minor, null);
  assert.equal(mapped.membership.kind, 'received');
  assert.equal(mapped.membership.gifter_channel_id, 'UC_GIFTER');
  assert.equal(mapped.membership.source_message_id, 'gifting-1');
});

/* -------------------------------------------------------- ignored events -- */

test('moderation and lifecycle events are dropped instead of being guessed into chat', () => {
  for (const type of IGNORED_YOUTUBE_EVENTS) {
    assert.equal(mapYouTubeChatMessage(message({snippet: {type}}), {receivedAt: RECEIVED}), null, type);
  }
  assert.equal(mapYouTubeChatMessage(message({snippet: {type: 'futureUnknownEvent'}})), null);
  assert.equal(mapYouTubeChatMessage(null), null);
  assert.equal(mapYouTubeChatMessage({}), null);
});

test('known event types are enumerated for diagnostics', () => {
  assert.equal(isKnownYouTubeEvent('superChatEvent'), true);
  assert.equal(isKnownYouTubeEvent('messageDeletedEvent'), false);
});

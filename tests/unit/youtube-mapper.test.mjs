import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractYouTubeEmoteCodes,
  mapYouTubeChatMessage,
  YOUTUBE_MAPPER_STATUS
} from '../../src/platforms/youtube/mapper.mjs';

const RECEIVED = 1_700_000_000_000;

function message(overrides = {}) {
  return {
    kind: 'youtube#liveChatMessage',
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

test('YouTube mapper is explicitly unverified until a real broadcast is sampled', () => {
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
  assert.equal(mapped.source_quality, 'unknown');
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

test('an emote-only YouTube message is kept with a null body', () => {
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
  assert.equal(mapped.source_quality, 'unknown');
});

test('Super Chat and membership events are not mislabelled as ordinary chat', () => {
  assert.equal(mapYouTubeChatMessage(message({snippet: {type: 'superChatEvent'}}), {receivedAt: RECEIVED}), null);
  assert.equal(mapYouTubeChatMessage(message({snippet: {type: 'membershipEvent'}}), {receivedAt: RECEIVED}), null);
  assert.equal(mapYouTubeChatMessage(null), null);
});

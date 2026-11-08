import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDisplayedAmount,
  parseAuthorBadges,
  runsToContent,
  timestampUsecToMs,
  parseChatPage,
  parseChatResponse,
  parseWatchPage,
  chatUnavailableReason
} from '../../src/platforms/youtube/anonymous/parser.mjs';
import {
  mapYouTubeAnonymousChatItem,
  YOUTUBE_ANONYMOUS_MAPPER_STATUS
} from '../../src/platforms/youtube/mapper.mjs';

const NOW = 1794145000000;

test('anonymous mapper status records which event families were sampled live', () => {
  assert.equal(YOUTUBE_ANONYMOUS_MAPPER_STATUS, 'verified-chat-superchat-gift');
});

test('explicit symbols and codes resolve to the right currency and minor units', () => {
  assert.deepEqual(parseDisplayedAmount('HK$2,000.00', {gl: 'AU'}), {
    amountMinor: 200000,
    currency: 'HKD',
    display: 'HK$2,000.00',
    currencySource: 'explicit'
  });
  assert.equal(parseDisplayedAmount('US$5.00', {gl: 'JP'}).amountMinor, 500);
  assert.equal(parseDisplayedAmount('A$5.00', {gl: 'US'}).currency, 'AUD');
  assert.equal(parseDisplayedAmount('€1.234,56', {gl: 'US'}).amountMinor, 123456);
  assert.equal(parseDisplayedAmount('₹1,00,000', {gl: 'US'}).amountMinor, 10000000);
  assert.equal(parseDisplayedAmount('JPY 1,500', {gl: 'US'}).amountMinor, 1500);
});

test('a bare $ or ¥ is resolved only by the page country, otherwise the amount stays unknown', () => {
  assert.deepEqual(parseDisplayedAmount('$5.00', {gl: 'US'}), {
    amountMinor: 500,
    currency: 'USD',
    display: '$5.00',
    currencySource: 'country'
  });
  const aud = parseDisplayedAmount('$5.00', {gl: 'AU'});
  assert.equal(aud.currency, 'AUD');
  assert.equal(aud.currencySource, 'country');
  const unknown = parseDisplayedAmount('$5.00', {gl: 'ZZ'});
  assert.equal(unknown.amountMinor, null);
  assert.equal(unknown.currency, null);
  const yen = parseDisplayedAmount('¥1,500', {gl: 'JP'});
  assert.equal(yen.currency, 'JPY');
  assert.equal(yen.amountMinor, 1500);
  const unconfirmed = parseDisplayedAmount('¥1,500', {gl: 'ZZ'});
  assert.equal(unconfirmed.amountMinor, null);
});

test('an unrecognized formatted amount is never guessed into money', () => {
  const result = parseDisplayedAmount('1,234 points', {gl: 'US'});
  assert.equal(result.amountMinor, null);
  assert.equal(result.currency, null);
  assert.equal(result.display, '1,234 points');
  assert.equal(parseDisplayedAmount(null).amountMinor, null);
});

test('runs preserve literal Unicode emoji and keep custom emoji as text plus metadata', () => {
  const result = runsToContent([
    {text: 'hello '},
    {emoji: {emojiId: '😂', isCustomEmoji: false, shortcuts: [':joy:']}},
    {text: ' '},
    {emoji: {emojiId: 'UC_CUSTOM/_a', isCustomEmoji: true, shortcuts: [':_YuuSmileeee:'], image: {thumbnails: [{url: 'https://img.invalid/a.png'}]}}}
  ]);
  assert.equal(result.content, 'hello 😂 :_YuuSmileeee:');
  assert.equal(result.content.includes('https://'), false);
  assert.deepEqual(result.emotes, [{
    id: 'UC_CUSTOM/_a',
    code: ':_YuuSmileeee:',
    name: '_YuuSmileeee',
    source: 'youtube.liveChat.runs'
  }]);
});

test('author badges are facts, not guesses', () => {
  const badges = parseAuthorBadges([
    {liveChatAuthorBadgeRenderer: {icon: {iconType: 'MODERATOR'}, accessibility: {accessibilityData: {label: 'Moderator'}}}},
    {liveChatAuthorBadgeRenderer: {icon: {iconType: 'OWNER'}, accessibility: {accessibilityData: {label: 'Owner'}}}},
    {liveChatAuthorBadgeRenderer: {icon: {iconType: 'VERIFIED'}, accessibility: {accessibilityData: {label: 'Verified'}}}},
    {liveChatAuthorBadgeRenderer: {customThumbnail: {thumbnails: []}, tooltip: 'Member (6 months)'}}
  ]);
  assert.deepEqual(badges, [
    {type: 'moderator', label: 'Moderator'},
    {type: 'owner', label: 'Owner'},
    {type: 'verified', label: 'Verified'},
    {type: 'member', label: 'Member (6 months)'}
  ]);
  assert.equal(parseAuthorBadges(null), null);
  assert.equal(parseAuthorBadges([{}]), null);
});

test('timestamps use integer microseconds without floating point loss', () => {
  assert.equal(timestampUsecToMs('1794144956117356'), 1794144956117);
  assert.equal(timestampUsecToMs('0'), null);
  assert.equal(timestampUsecToMs('abc'), null);
  assert.equal(timestampUsecToMs(null), null);
});

function watchHtml(playerOverrides = {}) {
  const player = {
    playabilityStatus: {status: 'OK'},
    videoDetails: {
      videoId: 'anonLIVE001',
      title: 'Live now',
      author: 'Channel',
      channelId: 'UC_CHANNEL',
      isLive: true,
      isLiveContent: true,
      isUpcoming: false
    },
    microformat: {
      playerMicroformatRenderer: {
        isFamilySafe: true,
        liveBroadcastDetails: {
          isLiveNow: true,
          startTimestamp: '2026-11-08T09:00:00.000Z'
        }
      }
    },
    ...playerOverrides
  };
  const initial = {
    contents: {
      twoColumnWatchNextResults: {
        results: {results: {contents: [{videoPrimaryInfoRenderer: {
          viewCount: {videoViewCountRenderer: {viewCount: {simpleText: '12,345 watching now'}}}
        }}]}}
      }
    }
  };
  return `<script>window["ytInitialPlayerResponse"] = ${JSON.stringify(player)};</script>`
    + `<script>window["ytInitialData"] = ${JSON.stringify(initial)};</script>`;
}

test('watch page state distinguishes live, upcoming, ended and ordinary video', () => {
  const live = parseWatchPage(watchHtml());
  assert.equal(live.ok, true);
  assert.equal(live.video.state, 'live');
  assert.equal(live.video.concurrentViewers, 12345);
  assert.equal(live.video.channelId, 'UC_CHANNEL');

  const ended = parseWatchPage(watchHtml({
    videoDetails: {videoId: 'anonLIVE001', isLive: false, isLiveContent: true, isUpcoming: false},
    microformat: {playerMicroformatRenderer: {liveBroadcastDetails: {
      isLiveNow: false,
      startTimestamp: '2026-11-08T09:00:00.000Z',
      endTimestamp: '2026-11-08T10:00:00.000Z'
    }}}
  }));
  assert.equal(ended.video.state, 'ended');

  const upcoming = parseWatchPage(watchHtml({
    videoDetails: {videoId: 'anonLIVE001', isLive: false, isLiveContent: true, isUpcoming: true},
    microformat: {playerMicroformatRenderer: {liveBroadcastDetails: {isLiveNow: false, startTimestamp: '2026-11-08T10:00:00.000Z'}}}
  }));
  assert.equal(upcoming.video.state, 'upcoming');

  const ordinary = parseWatchPage(watchHtml({
    videoDetails: {videoId: 'anonLIVE001', isLive: false, isLiveContent: false, isUpcoming: false},
    microformat: {playerMicroformatRenderer: {}}
  }));
  assert.equal(ordinary.video.state, 'video');
});

test('a consent or age wall is reported as restricted, never as live', () => {
  const restricted = parseWatchPage('<html><body>Sign in to confirm your age</body></html>');
  assert.equal(restricted.ok, false);
  assert.equal(restricted.reason, 'restricted');
});

const CONFIG = {
  INNERTUBE_API_KEY: 'AIzaPUBLIC',
  INNERTUBE_CONTEXT_CLIENT_NAME: 1,
  INNERTUBE_CONTEXT_CLIENT_VERSION: '2.20990101.00.00',
  INNERTUBE_CONTEXT: {client: {clientName: 'WEB', clientVersion: '2.20990101.00.00', gl: 'HK', visitorData: 'v'}}
};

function chatHtml(contents) {
  return `<script>ytcfg.set(${JSON.stringify(CONFIG)});</script>`
    + `<script>window["ytInitialData"] = ${JSON.stringify({contents})};</script>`;
}

test('chat page extraction keeps the real continuation and timeout', () => {
  const page = parseChatPage(chatHtml({
    liveChatRenderer: {
      continuations: [{invalidationContinuationData: {continuation: 'CONT', timeoutMs: 10000}}],
      actions: [{addChatItemAction: {item: {liveChatTextMessageRenderer: {id: 'm1'}}}}]
    }
  }));
  assert.equal(page.ok, true);
  assert.equal(page.continuation, 'CONT');
  assert.equal(page.timeoutMs, 10000);
  assert.equal(page.actions.length, 1);
  assert.equal(page.config.INNERTUBE_CONTEXT.client.gl, 'HK');
});

test('chat-disabled and ended pages are distinguished', () => {
  assert.equal(parseChatPage(chatHtml({
    messageRenderer: {text: {runs: [{text: 'Chat is disabled for this live stream.'}]}}
  })).reason, 'disabled');
  assert.equal(parseChatPage(chatHtml({
    messageRenderer: {text: {runs: [{text: 'This live chat has ended.'}]}}
  })).reason, 'ended');
  assert.equal(chatUnavailableReason({}), 'unavailable');
});

test('a continuation response with a new token and actions is normalized', () => {
  const page = parseChatResponse({
    continuationContents: {
      liveChatContinuation: {
        continuations: [{timedContinuationData: {continuation: 'NEXT', timeoutMs: 5000}}],
        actions: [{addChatItemAction: {item: {liveChatTextMessageRenderer: {id: 'm2'}}}}]
      }
    }
  });
  assert.equal(page.ended, false);
  assert.equal(page.continuation, 'NEXT');
  assert.equal(page.actions.length, 1);
  assert.equal(parseChatResponse({}).ended, true);
});

test('anonymous text mapping uses the real channel id and no nickname identity', () => {
  const mapped = mapYouTubeAnonymousChatItem({
    liveChatTextMessageRenderer: {
      id: 'm1',
      timestampUsec: String((NOW + 1000) * 1000),
      authorName: {simpleText: '@Alice'},
      authorExternalChannelId: 'UC_ALICE',
      message: {runs: [{text: 'hi 😂'}]}
    }
  }, {receivedAt: NOW, gl: 'HK'});
  assert.equal(mapped.viewer_uid, 'UC_ALICE');
  assert.equal(mapped.display_name, '@Alice');
  assert.equal(mapped.content, 'hi 😂');
  assert.equal(mapped.source_quality, 'verified');
  assert.equal(mapped.occurred_at, NOW + 1000);

  const anonymous = mapYouTubeAnonymousChatItem({
    liveChatTextMessageRenderer: {
      id: 'm2',
      authorName: {simpleText: 'No Channel'},
      message: {runs: [{text: 'hello'}]}
    }
  }, {receivedAt: NOW, gl: 'HK'});
  assert.equal(anonymous.viewer_uid, null);
  assert.equal(anonymous.identity_complete, false);
  assert.equal(anonymous.source_quality, 'unknown');
});

test('anonymous Super Chat preserves the displayed string and parses only confirmable money', () => {
  const mapped = mapYouTubeAnonymousChatItem({
    liveChatPaidMessageRenderer: {
      id: 'sc-1',
      timestampUsec: String(NOW * 1000),
      authorName: {simpleText: '@Payer'},
      authorExternalChannelId: 'UC_PAY',
      purchaseAmountText: {simpleText: 'HK$2,000.00'},
      message: {runs: [{text: 'support'}]}
    }
  }, {receivedAt: NOW, gl: 'AU'});
  assert.equal(mapped.event_type, 'super_chat');
  assert.equal(mapped.amount_minor, 200000);
  assert.equal(mapped.amount_display, 'HK$2,000.00');
  assert.equal(mapped.currency, 'HKD');
  assert.equal(mapped.value_kind, 'actual');
  assert.equal(mapped.source_quality, 'estimated');
});

test('anonymous gifts are paid events without an invented price or identity', () => {
  const mapped = mapYouTubeAnonymousChatItem({
    giftMessageViewModel: {
      id: 'gift-1',
      text: {content: 'sent Mango lassi'},
      authorName: {content: '@Gifter '},
      giftImage: {sources: [{url: '//example.invalid/mango_lassi.png=w480'}]},
      giftImageA11yLabel: '@Gifter sent a gift, Mango lassi'
    }
  }, {receivedAt: NOW, gl: 'AU'});
  assert.equal(mapped.event_type, 'gift');
  assert.equal(mapped.viewer_uid, null);
  assert.equal(mapped.display_name, '@Gifter');
  assert.equal(mapped.gift_id, 'mango_lassi');
  assert.equal(mapped.gift_name, 'sent Mango lassi');
  assert.equal(mapped.is_paid, true);
  assert.equal(mapped.amount_minor, null);
  assert.equal(mapped.value_kind, 'unknown');
});

test('anonymous membership keeps the header and comment but never invents a price', () => {
  const mapped = mapYouTubeAnonymousChatItem({
    liveChatMembershipItemRenderer: {
      id: 'member-1',
      timestampUsec: String(NOW * 1000),
      authorName: {simpleText: '@Member'},
      authorExternalChannelId: 'UC_MEMBER',
      headerSubtext: {runs: [{text: 'Member for 6 months'}]},
      message: {runs: [{text: 'thank you'}]}
    }
  }, {receivedAt: NOW});
  assert.equal(mapped.event_type, 'membership');
  assert.equal(mapped.content, 'thank you');
  assert.equal(mapped.gift_name, 'Member for 6 months');
  assert.equal(mapped.amount_minor, null);
  assert.equal(mapped.is_paid, true);
  assert.equal(mapped.viewer_uid, 'UC_MEMBER');
});

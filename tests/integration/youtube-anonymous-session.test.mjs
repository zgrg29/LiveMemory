import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {readZipEntry, readZipIndex} from '../../src/shared/zip.mjs';
import {buildAnalysisPackage} from '../../src/ai/export/package.mjs';

/**
 * End-to-end test for the public-web YouTube client (the only YouTube path).
 *
 * The fake server reproduces the real page/JSON shapes captured from live
 * broadcasts, including a Super Chat with a formatted HK$ amount, an anonymous
 * gift without a channel id, a membership and a member badge. It proves the
 * transport -> mapper -> EventIngest -> SQLite -> read-model chain without
 * contacting YouTube.
 */

const VIDEO_ID = 'anonLIVE001';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, {timeout = 10000, interval = 100} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)});
  res.end(payload);
}

function html(res, body) {
  res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
  res.end(body);
}

const config = {
  INNERTUBE_API_KEY: 'AIzaFAKE_WEB_KEY',
  INNERTUBE_CONTEXT_CLIENT_NAME: 1,
  INNERTUBE_CONTEXT_CLIENT_VERSION: '2.20990101.00.00',
  INNERTUBE_CONTEXT: {
    client: {
      clientName: 'WEB',
      clientVersion: '2.20990101.00.00',
      gl: 'HK',
      hl: 'en',
      visitorData: 'VISITOR_TEST'
    }
  }
};

function textRenderer(id, text, {channelId = 'UC_CHAT', name = 'Alice', badges = null, timestampUsec = '1794144956117356'} = {}) {
  return {
    liveChatTextMessageRenderer: {
      id,
      timestampUsec,
      authorName: {simpleText: name},
      authorExternalChannelId: channelId,
      authorBadges: badges ?? [],
      message: {runs: [{text}]}
    }
  };
}

function paidRenderer(id, amount, {channelId = 'UC_PAY', name = 'Payer', text = 'support'} = {}) {
  return {
    liveChatPaidMessageRenderer: {
      id,
      timestampUsec: '1794144956117357',
      authorName: {simpleText: name},
      authorExternalChannelId: channelId,
      authorBadges: [{
        liveChatAuthorBadgeRenderer: {
          customThumbnail: {thumbnails: [{url: 'https://example.invalid/badge', width: 16}]},
          tooltip: 'Member (1 year)',
          accessibility: {accessibilityData: {label: 'Member (1 year)'}}
        }
      }],
      purchaseAmountText: {simpleText: amount},
      message: {runs: [{text}]}
    }
  };
}

const initialActions = [
  {
    addChatItemAction: {
      item: textRenderer('chat-1', 'hello 😂', {
        badges: [{liveChatAuthorBadgeRenderer: {icon: {iconType: 'MODERATOR'}, accessibility: {accessibilityData: {label: 'Moderator'}}}}]
      })
    }
  },
  {addChatItemAction: {item: paidRenderer('sc-1', 'HK$2,000.00', {text: 'great stream :_YuuSmileeee:'})}},
  {
    addChatItemAction: {
      item: {
        liveChatMembershipItemRenderer: {
          id: 'member-1',
          timestampUsec: '1794144956117358',
          authorName: {simpleText: 'Member'},
          authorExternalChannelId: 'UC_MEMBER',
          headerSubtext: {runs: [{text: 'Member for 6 months'}]},
          message: {runs: [{text: 'thank you'}]}
        }
      }
    }
  },
  {
    addChatItemAction: {
      item: {
        liveChatPaidStickerRenderer: {
          id: 'sticker-1',
          timestampUsec: '1794144956117359',
          authorName: {simpleText: 'Sticker Fan'},
          authorExternalChannelId: 'UC_STICKER',
          purchaseAmountText: {simpleText: 'US$2.00'},
          sticker: {
            stickerId: 'cat-sticker',
            accessibility: {accessibilityData: {label: 'cheering cat'}}
          }
        }
      }
    }
  },
  // Ticker presentation duplicates an amount; it must not create a second event.
  {addLiveChatTickerItemAction: {item: {liveChatPaidMessageRenderer: {id: 'sc-1'}}}},
  // Deleted/placeholder items are ignored.
  {addChatItemAction: {item: {liveChatPlaceholderItemRenderer: {id: 'placeholder'}}}}
];

const giftAction = {
  addChatItemAction: {
    item: {
      giftMessageViewModel: {
        id: 'gift-1',
        text: {content: 'sent Mango lassi'},
        authorName: {content: '@GiftSender '},
        giftImage: {sources: [{url: '//example.invalid/mango_lassi.png=w480'}]},
        giftImageA11yLabel: '@GiftSender sent a gift, Mango lassi'
      }
    }
  }
};

const duplicateAction = {
  addChatItemAction: {
    item: textRenderer('chat-1', 'hello 😂')
  }
};

function watchHtml(isLive = true, ended = false) {
  const player = {
    playabilityStatus: {status: 'OK'},
    videoDetails: {
      videoId: VIDEO_ID,
      title: 'Anonymous live test',
      author: 'Test Channel',
      channelId: 'UC_TEST_CHANNEL',
      isLive,
      isLiveContent: true,
      isUpcoming: false
    },
    microformat: {
      playerMicroformatRenderer: {
        isFamilySafe: true,
        liveBroadcastDetails: {
          isLiveNow: isLive,
          startTimestamp: '2026-11-08T09:00:00.000Z',
          ...(ended ? {endTimestamp: '2026-11-08T10:00:00.000Z'} : {})
        }
      }
    }
  };
  const initial = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [{
              videoPrimaryInfoRenderer: {
                viewCount: {videoViewCountRenderer: {viewCount: {simpleText: '1,234 watching now'}}}
              }
            }]
          }
        }
      }
    }
  };
  return `<html><body><script>window["ytInitialPlayerResponse"] = ${JSON.stringify(player)};</script>`
    + `<script>window["ytInitialData"] = ${JSON.stringify(initial)};</script></body></html>`;
}

function chatHtml(disabled = false) {
  const initial = disabled
    ? {contents: {messageRenderer: {text: {runs: [{text: 'Chat is disabled for this live stream.'}]}}}}
    : {
      contents: {
        liveChatRenderer: {
          continuations: [{
            invalidationContinuationData: {
              continuation: 'CONTINUATION-1',
              timeoutMs: 2000
            }
          }],
          actions: initialActions
        }
      }
    };
  return `<html><body><script>ytcfg.set(${JSON.stringify(config)});</script>`
    + `<script>window["ytInitialData"] = ${JSON.stringify(initial)};</script></body></html>`;
}

async function startFakeWeb() {
  const calls = [];
  let pollCount = 0;
  let ended = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    calls.push({method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams)});
    if (req.method === 'GET' && url.pathname === '/watch') {
      return html(res, watchHtml(!ended, ended));
    }
    if (req.method === 'GET' && url.pathname === '/live_chat') {
      return html(res, chatHtml(false));
    }
    if (req.method === 'POST' && url.pathname === '/youtubei/v1/live_chat/get_live_chat') {
      pollCount += 1;
      if (pollCount === 1) {
        return json(res, 200, {
          continuationContents: {
            liveChatContinuation: {
              continuations: [{invalidationContinuationData: {continuation: 'CONTINUATION-2', timeoutMs: 2000}}],
              actions: [
                {addChatItemAction: {item: giftAction.addChatItemAction.item}},
                duplicateAction
              ]
            }
          }
        });
      }
      // A real ended broadcast can return a 200 without continuationContents.
      // That is ambiguous on its own; the adapter confirms it against the
      // watch page (which now reports the broadcast as ended).
      ended = true;
      return json(res, 200, {});
    }
    return json(res, 404, {error: {code: 404}});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function request(url, {method = 'GET', body = null} = {}) {
  return fetch(url, {
    method,
    headers: body ? {'content-type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined
  });
}

test('public-web YouTube chat end-to-end (the only YouTube path)', async (t) => {
  const fake = await startFakeWeb();
  const temp = createTempDir();
  const server = await startServer({
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    youtubeWebBase: fake.base
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
    await fake.close();
  });
  const base = server.url;

  await t.test('the public web chat is the only YouTube path and needs no credentials', async () => {
    const status = await (await fetch(`${base}api/youtube/status`)).json();
    assert.equal(status.mode, 'web');
    assert.equal(status.available, true);
    assert.equal(status.capabilities.requiresApiKey, false);
    assert.equal(status.capabilities.requiresLogin, false);
    assert.equal(status.capabilities.requiresCookie, false);
    assert.equal(status.captureMode, undefined);
    assert.equal(status.officialConfigured, undefined);
    assert.equal(status.oauthConfigured, undefined);
    assert.equal(status.quota, undefined);
    const login = await fetch(`${base}api/youtube/login/status`);
    assert.equal(login.status, 404);
    const patch = await request(`${base}api/settings`, {
      method: 'PATCH',
      body: {youtubeCaptureMode: 'anonymous'}
    });
    assert.equal(patch.status, 400);
  });

  await t.test('a live link is checked against the public watch and chat pages', async () => {
    const response = await request(`${base}api/youtube/video`, {
      method: 'POST',
      body: {url: `https://www.youtube.com/live/${VIDEO_ID}`}
    });
    assert.equal(response.status, 200);
    const {video} = await response.json();
    assert.equal(video.videoId, VIDEO_ID);
    assert.equal(video.recordable, true);
    assert.equal(video.chatAvailable, true);
    assert.equal(video.concurrentViewers, 1234);
    assert.equal(video.mode, undefined);
    assert.equal(video.experimental, undefined);
  });

  let sessionId = null;
  await t.test('recording ingests chat, badges, Super Chat, stickers, membership and gifts', async () => {
    const response = await request(`${base}api/youtube/connect`, {
      method: 'POST',
      body: {url: `https://youtu.be/${VIDEO_ID}`}
    });
    assert.equal(response.status, 201);
    const payload = await response.json();
    sessionId = payload.session.id;
    assert.equal(payload.session.platform, 'youtube');
    assert.equal(payload.connection.detail.mode, 'web');

    const events = await waitFor(async () => {
      const body = await (await fetch(`${base}api/events?sessionId=${sessionId}&limit=50`)).json();
      return body.events.length >= 5 ? body.events : null;
    });
    // 1 chat + 1 SC + 1 membership + 1 sticker + 1 gift. Duplicate chat and
    // ticker are dropped.
    assert.equal(events.length, 5);

    const chat = events.find((event) => event.type === 'chat');
    assert.equal(chat.content, 'hello 😂');
    assert.equal(chat.viewerId, 'youtube:UC_CHAT');
    assert.deepEqual(chat.badges, [{type: 'moderator', label: 'Moderator'}]);

    const sc = events.find((event) => event.type === 'super_chat');
    assert.equal(sc.amountMinor, 200000);
    assert.equal(sc.amountDisplay, 'HK$2,000.00');
    assert.equal(sc.currency, 'HKD');
    assert.equal(sc.valueKind, 'actual');
    assert.equal(sc.viewerId, 'youtube:UC_PAY');
    assert.deepEqual(sc.badges, [{type: 'member', label: 'Member (1 year)'}]);

    const membership = events.find((event) => event.type === 'membership');
    assert.equal(membership.viewerId, 'youtube:UC_MEMBER');
    assert.equal(membership.amountMinor, null);
    assert.equal(membership.content, 'thank you');

    const sticker = events.find((event) => event.type === 'super_sticker');
    assert.equal(sticker.amountMinor, 200);
    assert.equal(sticker.currency, 'USD');
    assert.equal(sticker.giftName, 'cheering cat');

    const gift = events.find((event) => event.type === 'gift');
    assert.equal(gift.viewerId, null);
    assert.equal(gift.displayName, '@GiftSender');
    assert.equal(gift.amountMinor, null);
    assert.equal(gift.isPaid, true);
    assert.equal(gift.giftName, 'sent Mango lassi');
  });

  await t.test('stable channel ids drive viewer profiles; gift senders without one do not', async () => {
    const viewers = await (await fetch(`${base}api/viewers?limit=50`)).json();
    const ids = viewers.viewers.filter((viewer) => viewer.platform === 'youtube').map((viewer) => viewer.platformUid).sort();
    assert.deepEqual(ids, ['UC_CHAT', 'UC_MEMBER', 'UC_PAY', 'UC_STICKER']);
  });

  await t.test('the fake chat ends and the session is saved', async () => {
    await waitFor(async () => {
      const body = await (await fetch(`${base}api/sessions?limit=5`)).json();
      const row = body.sessions.find((session) => session.id === sessionId);
      return row?.status === 'ended' ? row : null;
    }, {timeout: 15000});
    const summary = await (await fetch(`${base}api/sessions/${sessionId}`)).json();
    assert.equal(summary.session.status, 'ended');
  });

  await t.test('the retention policy caps at 30 days', async () => {
    const response = await request(`${base}api/settings`, {
      method: 'PATCH',
      body: {youtubeRawRetentionDays: 45}
    });
    assert.equal(response.status, 400);
    const status = await (await fetch(`${base}api/youtube/status`)).json();
    assert.equal(status.policy.days, 30);
    assert.equal(status.policy.maxDays, 30);
  });

  await t.test('the analysis package carries badges and the displayed amount', async () => {
    const record = await buildAnalysisPackage({
      db: server.db,
      sessionId,
      locale: 'en',
      exportsDir: server.paths.exports
    });
    const archive = readFileSync(join(server.paths.exports, record.fileName));
    const names = readZipIndex(archive).map((entry) => entry.name);
    assert.ok(names.includes('messages.jsonl'));
    const lines = readZipEntry(archive, 'messages.jsonl').toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
    const sc = lines.find((line) => line.type === 'super_chat');
    assert.equal(sc.amount_display, 'HK$2,000.00');
    assert.equal(sc.amount_minor, 200000);
    const chat = lines.find((line) => line.type === 'chat');
    assert.deepEqual(chat.badges, [{type: 'moderator', label: 'Moderator'}]);
  });
});

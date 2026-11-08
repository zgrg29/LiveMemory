import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';

/**
 * End-to-end YouTube Live test against a local fake of the official Data API.
 *
 * This proves the whole local chain (HTTP API -> OAuth/API-key credential
 * resolution -> live chat polling -> mapper -> EventIngest -> SQLite -> read
 * models) without pretending that a real Google credential was used. The fake
 * answers with the documented response shapes only.
 */

const API_KEY = 'AIzaFAKETESTKEY0000000000000000000000';
const LIVE_ID = 'vidLIVE0001';
const NORMAL_ID = 'vidNORMAL01';
const CHAT_ID = 'CHAT-TEST-1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, {timeout = 8000, interval = 100} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

function chatItem(id, text, {channelId = 'UC_A', name = 'Alice', type = 'textMessageEvent', extra = {}} = {}) {
  const snippet = {
    type,
    publishedAt: '2026-11-08T10:00:05.000Z',
    displayMessage: text,
    authorChannelId: {value: channelId},
    ...extra
  };
  if (type === 'textMessageEvent') snippet.textMessageDetails = {messageText: text};
  return {id, snippet, authorDetails: {channelId, displayName: name}};
}

function chatPage() {
  return {
    pollingIntervalMillis: 2000,
    nextPageToken: 'PAGE-2',
    items: [
      chatItem('m1', 'hello 😂 :face-blue-smiling:', {name: 'Alice'}),
      chatItem('m2', 'hi from Bob', {channelId: 'UC_B', name: 'Bob'}),
      // The same platform message id delivered twice in one page: the write
      // pipeline must keep exactly one row.
      chatItem('m1', 'hello 😂 :face-blue-smiling:', {name: 'Alice'}),
      chatItem('sc-usd', 'Nice stream', {
        channelId: 'UC_C',
        name: 'Carol',
        type: 'superChatEvent',
        extra: {superChatDetails: {amountMicros: '5000000', currency: 'USD', amountDisplayString: '$5.00', userComment: 'Nice stream', tier: 1}}
      }),
      chatItem('sc-jpy', 'ありがとう', {
        channelId: 'UC_D',
        name: 'Dan',
        type: 'superChatEvent',
        extra: {superChatDetails: {amountMicros: '1500000000', currency: 'JPY', amountDisplayString: '¥1,500', userComment: 'ありがとう', tier: 3}}
      }),
      chatItem('sticker-1', '', {
        channelId: 'UC_E',
        name: 'Eve',
        type: 'superStickerEvent',
        extra: {superStickerDetails: {amountMicros: '2000000', currency: 'EUR', superStickerMetadata: {stickerId: 'cat-1', altText: 'cheering cat'}}}
      }),
      chatItem('member-1', '', {
        channelId: 'UC_F',
        name: 'Frank',
        type: 'newSponsorEvent',
        extra: {newSponsorDetails: {memberLevelName: 'Tier 1', isUpgrade: false}}
      }),
      chatItem('gifted-1', '', {
        channelId: 'UC_G',
        name: 'Grace',
        type: 'giftMembershipReceivedEvent',
        extra: {giftMembershipReceivedDetails: {memberLevelName: 'Tier 1', gifterChannelId: 'UC_F', associatedMembershipGiftingMessageId: 'member-1'}}
      }),
      chatItem('gifting-1', '', {
        channelId: 'UC_A',
        name: 'Alice',
        type: 'membershipGiftingEvent',
        extra: {membershipGiftingDetails: {giftMembershipsCount: 3, giftMembershipsLevelName: 'Tier 1'}}
      }),
      chatItem('deleted-1', '', {channelId: 'UC_X', name: 'X', type: 'messageDeletedEvent'})
    ]
  };
}

async function startFakeYouTube() {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    calls.push({path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? null});
    const json = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)});
      res.end(payload);
    };
    if (url.pathname === '/youtube/v3/videos') {
      const id = url.searchParams.get('id');
      if (id === NORMAL_ID) {
        return json(200, {items: [{
          id,
          snippet: {title: 'An ordinary upload', channelId: 'UC_CHANNEL', channelTitle: 'Streamer', liveBroadcastContent: 'none'},
          status: {privacyStatus: 'public'}
        }]});
      }
      if (id !== LIVE_ID) return json(200, {items: []});
      return json(200, {items: [{
        id,
        snippet: {title: 'Live test broadcast', channelId: 'UC_CHANNEL', channelTitle: 'Streamer', liveBroadcastContent: 'live'},
        liveStreamingDetails: {
          actualStartTime: '2026-11-08T09:00:00.000Z',
          concurrentViewers: '42',
          activeLiveChatId: CHAT_ID
        },
        status: {privacyStatus: 'public'}
      }]});
    }
    if (url.pathname === '/youtube/v3/liveChat/messages') {
      if (url.searchParams.get('pageToken') === 'PAGE-2') {
        return json(200, {pollingIntervalMillis: 2000, nextPageToken: 'PAGE-3', items: []});
      }
      return json(200, chatPage());
    }
    return json(404, {error: {code: 404, errors: [{reason: 'notFound'}]}});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}/youtube/v3`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function jsonRequest(url, {method = 'GET', body, headers = {}} = {}) {
  return fetch(url, {
    method,
    headers: body === undefined ? headers : {'content-type': 'application/json', ...headers},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test('YouTube live chat end-to-end through the local pipeline', async (t) => {
  const fake = await startFakeYouTube();
  const temp = createTempDir();
  const previousKey = process.env.LIVE_MEMORY_YOUTUBE_API_KEY;
  process.env.LIVE_MEMORY_YOUTUBE_API_KEY = API_KEY;
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en', youtubeApiBase: fake.base});
  t.after(async () => {
    await server.close();
    temp.cleanup();
    await fake.close();
    if (previousKey === undefined) delete process.env.LIVE_MEMORY_YOUTUBE_API_KEY;
    else process.env.LIVE_MEMORY_YOUTUBE_API_KEY = previousKey;
  });
  const base = server.url;

  await t.test('the anonymous API-key mode needs no sign-in', async () => {
    const status = await (await fetch(`${base}api/youtube/status`)).json();
    assert.equal(status.configured, true);
    assert.equal(status.authMode, 'api-key');
    assert.equal(status.capabilities.requiresSignIn, false);
    assert.equal(status.policy.days, 30);
    assert.equal(status.quota.limit, 10000);
  });

  await t.test('a live link is resolved and marked recordable', async () => {
    const response = await jsonRequest(`${base}api/youtube/video`, {
      method: 'POST',
      body: {url: `https://www.youtube.com/live/${LIVE_ID}`}
    });
    assert.equal(response.status, 200);
    const {video} = await response.json();
    assert.equal(video.videoId, LIVE_ID);
    assert.equal(video.recordable, true);
    assert.equal(video.title, 'Live test broadcast');
    assert.equal(video.chatAvailable, true);
    assert.equal(video.concurrentViewers, 42);
    // The API key is used as a query parameter, never as a bearer token.
    assert.equal(fake.calls.at(-1).query.key, API_KEY);
    assert.equal(fake.calls.at(-1).auth, null);
  });

  await t.test('a normal uploaded video is refused with a clear reason', async () => {
    const response = await jsonRequest(`${base}api/youtube/video`, {
      method: 'POST',
      body: {url: `https://youtu.be/${NORMAL_ID}`}
    });
    assert.equal(response.status, 200);
    const {video} = await response.json();
    assert.equal(video.recordable, false);
    assert.equal(video.state, 'video');
  });

  await t.test('connecting refuses a non-live video with HTTP 409', async () => {
    const response = await jsonRequest(`${base}api/youtube/connect`, {
      method: 'POST',
      body: {url: `https://www.youtube.com/watch?v=${NORMAL_ID}`}
    });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error.code, 'YOUTUBE_NOT_LIVE_VIDEO');
    assert.equal(payload.error.messageKey, 'errors.youtubeNotLive');
  });

  await t.test('an invalid link is rejected before any network call', async () => {
    const before = fake.calls.length;
    const response = await jsonRequest(`${base}api/youtube/video`, {
      method: 'POST',
      body: {url: 'https://example.com/nope'}
    });
    assert.equal(response.status, 400);
    assert.equal(fake.calls.length, before);
  });

  let sessionId = null;
  await t.test('recording a live broadcast ingests chat, Super Chat, Super Sticker and memberships', async () => {
    const response = await jsonRequest(`${base}api/youtube/connect`, {
      method: 'POST',
      body: {url: `https://youtu.be/${LIVE_ID}`}
    });
    assert.equal(response.status, 201);
    const payload = await response.json();
    sessionId = payload.session.id;
    assert.equal(payload.session.platform, 'youtube');
    assert.equal(payload.session.roomTitle, 'Live test broadcast');
    assert.equal(payload.session.broadcasterName, 'Streamer');
    assert.equal(payload.session.platformStartedAt, Date.parse('2026-11-08T09:00:00.000Z'));

    const events = await waitFor(async () => {
      const body = await (await fetch(`${base}api/events?sessionId=${sessionId}&limit=50`)).json();
      return body.events.length >= 8 ? body.events : null;
    });
    // 10 delivered items, 1 ignored (deleted), 1 duplicate id -> 8 rows.
    assert.equal(events.length, 8);
    const byId = Object.fromEntries(events.map((event) => [event.id, event]));

    const chat = events.find((event) => event.type === 'chat' && event.content?.startsWith('hello'));
    assert.ok(chat, 'chat message stored');
    assert.equal(chat.displayName, 'Alice');
    assert.equal(chat.viewerId, 'youtube:UC_A');
    assert.equal(chat.content, 'hello 😂 :face-blue-smiling:');
    assert.deepEqual(chat.emotes, [{code: ':face-blue-smiling:', name: 'face-blue-smiling', source: 'youtube.messageText'}]);

    const scUsd = events.find((event) => event.type === 'super_chat' && event.currency === 'USD');
    assert.equal(scUsd.amountMinor, 500);
    assert.equal(scUsd.valueKind, 'actual');
    assert.equal(scUsd.content, 'Nice stream');

    const scJpy = events.find((event) => event.type === 'super_chat' && event.currency === 'JPY');
    assert.equal(scJpy.amountMinor, 1500);

    const sticker = events.find((event) => event.type === 'super_sticker');
    assert.equal(sticker.amountMinor, 200);
    assert.equal(sticker.currency, 'EUR');
    assert.equal(sticker.giftName, 'cheering cat');

    const received = events.find((event) => event.displayName === 'Grace');
    assert.equal(received.type, 'membership');
    assert.equal(received.isPaid, false);

    const gifting = events.find((event) => event.type === 'membership' && event.giftQuantity === 3);
    assert.ok(gifting);

    assert.equal(events.some((event) => event.type === 'system'), false);
    void byId;
  });

  await t.test('the session totals keep currencies separate and never count a recipient as a payer', async () => {
    const summary = await (await fetch(`${base}api/sessions/${sessionId}`)).json();
    const usd = summary.support.find((entry) => entry.currency === 'USD');
    const jpy = summary.support.find((entry) => entry.currency === 'JPY');
    const eur = summary.support.find((entry) => entry.currency === 'EUR');
    assert.equal(usd.actualMinor, 500);
    assert.equal(jpy.actualMinor, 1500);
    assert.equal(eur.actualMinor, 200);
    // 4 messages (2 chat + 2 Super Chat) and 5 paid events
    // (2 Super Chat + 1 Super Sticker + 1 new membership + 1 gifting).
    assert.equal(summary.stats.messages, 4);
    assert.equal(summary.stats.paymentEvents, 5);
  });

  await t.test('viewers are keyed by stable channel id, not by nickname', async () => {
    const viewers = await (await fetch(`${base}api/viewers?limit=50`)).json();
    const youtube = viewers.viewers.filter((viewer) => viewer.platform === 'youtube');
    assert.equal(youtube.length, 7);
    const grace = youtube.find((viewer) => viewer.platformUid === 'UC_G');
    assert.ok(grace);
    assert.equal(grace.nickname, 'Grace');
    assert.equal(grace.messageCount, 0);
    // The recipient of a gifted membership is not a payer.
    assert.equal(grace.paymentEventCount, 0);
    const carol = youtube.find((viewer) => viewer.platformUid === 'UC_C');
    assert.equal(carol.paymentEventCount, 1);
  });

  await t.test('the broadcast appears in live history after the recording stops', async () => {
    const response = await jsonRequest(`${base}api/youtube/disconnect`, {method: 'POST', body: {}});
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.stopped, true);
    assert.equal(payload.session.status, 'ended');

    const history = await (await fetch(`${base}api/sessions?limit=5`)).json();
    const row = history.sessions.find((session) => session.id === sessionId);
    assert.equal(row.platform, 'youtube');
    assert.equal(row.endedAt !== null, true);
  });

  await t.test('the retention policy can be applied manually', async () => {
    const response = await jsonRequest(`${base}api/youtube/retention/apply`, {method: 'POST', body: {}});
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.status.days, 30);
    assert.equal(payload.status.pendingPurge, 0);
    assert.equal(payload.summary.days, 30);
  });
});

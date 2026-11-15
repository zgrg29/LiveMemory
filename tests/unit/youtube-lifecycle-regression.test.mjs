import test from 'node:test';
import assert from 'node:assert/strict';
import {YouTubeAnonymousLiveChatAdapter} from '../../src/platforms/youtube/anonymous/adapter.mjs';
import {parseChatResponse} from '../../src/platforms/youtube/anonymous/parser.mjs';
import {YouTubeApiError, YOUTUBE_ERRORS} from '../../src/platforms/youtube/errors.mjs';

/**
 * P0-4 regression: temporary YouTube transport failures must never be reported
 * as the broadcast ending.
 *
 * These tests drive the adapter directly with a controllable client. They use a
 * tiny injected timer so a 30-second production backoff does not make the suite
 * slow; the adapter still computes the real delay and exposes it in `detail`.
 */

const VIDEO = {
  videoId: 'anonLIVE001',
  title: 'Live',
  channelTitle: 'Channel',
  state: 'live',
  isLive: true,
  concurrentViewers: 10
};

const ACTION = {
  addChatItemAction: {
    item: {
      liveChatTextMessageRenderer: {
        id: 'm1',
        timestampUsec: '1794145000000000',
        authorName: {simpleText: 'Alice'},
        authorExternalChannelId: 'UC_A',
        message: {runs: [{text: 'hello'}]}
      }
    }
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 5000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(5);
  }
}

function fastTimers() {
  return {
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(Number(ms) || 0, 2)),
    clearTimeout: (handle) => clearTimeout(handle)
  };
}

function livePage(overrides = {}) {
  return {
    actions: [ACTION],
    continuation: 'NEXT',
    timeoutMs: 20,
    ended: false,
    invalid: false,
    ...overrides
  };
}

function rateLimited(retryAfterMs = 0) {
  return new YouTubeApiError(YOUTUBE_ERRORS.RATE_LIMITED, {
    messageKey: 'errors.youtubeRateLimit',
    httpStatus: 429,
    details: {retryAfterMs}
  });
}

function networkError(status = 502) {
  return new YouTubeApiError(YOUTUBE_ERRORS.WEB_NETWORK, {
    messageKey: 'errors.youtubeWebNetwork',
    httpStatus: status,
    details: {status}
  });
}

function adapterFor(client, options = {}) {
  return new YouTubeAnonymousLiveChatAdapter({
    videoId: VIDEO.videoId,
    video: {...VIDEO},
    client,
    timers: fastTimers(),
    minPollIntervalMs: 5,
    maxPollIntervalMs: 20,
    metadataIntervalMs: 60000,
    backoffBaseMs: 5,
    maxBackoffMs: 20,
    rateLimitMinBackoffMs: 40,
    maxConsecutiveFailures: 3,
    endConfirmDelayMs: 10,
    ...options
  });
}

function baseClient(overrides = {}) {
  return {
    async getVideo() {
      return {...VIDEO};
    },
    async openChat() {
      return {continuation: 'CONT-1', actions: [], timeoutMs: 20, gl: 'US', config: {}};
    },
    async poll() {
      return livePage();
    },
    ...overrides
  };
}

function trackPolling(client) {
  let active = 0;
  let maxActive = 0;
  const original = client.poll;
  client.poll = async (...args) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      return await original(...args);
    } finally {
      active -= 1;
    }
  };
  return () => maxActive;
}

function collectStates() {
  const states = [];
  return {
    states,
    onChange(change) {
      states.push({state: change.state, detail: change.detail ?? {}});
    }
  };
}

test('ten consecutive HTTP 429 responses never end the session and then recover', async () => {
  let polls = 0;
  const client = baseClient({
    async poll() {
      polls += 1;
      if (polls <= 10) throw rateLimited(1500);
      return livePage({actions: [ACTION], continuation: `NEXT-${polls}`});
    }
  });
  const maxConcurrent = trackPolling(client);
  const adapter = adapterFor(client, {maxConsecutiveFailures: 1});
  const events = [];
  const ended = [];
  const observer = collectStates();
  await adapter.start({
    onEvent: (event) => events.push(event),
    onEnd: (info) => ended.push(info),
    onStateChange: observer.onChange
  });
  await waitFor(() => events.length >= 1 || ended.length > 0 || polls >= 11);
  assert.equal(ended.length, 0, 'HTTP 429 is a retryable transport failure, not an end');
  assert.ok(polls >= 11, `expected at least 11 polls, saw ${polls}`);
  assert.equal(adapter.state, 'connected');
  assert.equal(adapter.snapshot().detail.failures, 0);
  assert.equal(maxConcurrent(), 1, 'reconnection must not create overlapping pollers');
  const retryDelays = observer.states
    .filter((entry) => ['reconnecting', 'failed'].includes(entry.state))
    .map((entry) => Number(entry.detail.retryInMs) || 0);
  assert.ok(retryDelays.length >= 10, 'every 429 should schedule a bounded retry');
  assert.ok(Math.max(...retryDelays) >= 1500, 'Retry-After must be honoured');
  assert.ok(retryDelays.every((delay) => delay > 0), 'no zero-delay retry loop');
  assert.ok(observer.states.some((entry) => entry.state === 'failed' && entry.detail.retrying === true));
  await adapter.stop();
});

test('consecutive network failures enter a recoverable failed state and never call onEnd', async () => {
  let polls = 0;
  const client = baseClient({
    async poll() {
      polls += 1;
      if (polls <= 12) throw networkError(502);
      return livePage({continuation: `NEXT-${polls}`});
    }
  });
  const maxConcurrent = trackPolling(client);
  const adapter = adapterFor(client, {maxConsecutiveFailures: 3});
  const events = [];
  const ended = [];
  const observer = collectStates();
  await adapter.start({
    onEvent: (event) => events.push(event),
    onEnd: (info) => ended.push(info),
    onStateChange: observer.onChange
  });
  await waitFor(() => events.length >= 1 || ended.length > 0 || polls >= 13);
  assert.equal(ended.length, 0, 'a network outage is not a broadcast end');
  assert.ok(polls >= 13, `expected repeated recovery attempts, saw ${polls}`);
  assert.equal(adapter.state, 'connected');
  const failed = observer.states.filter((entry) => entry.state === 'failed');
  assert.ok(failed.length > 0, 'the failure must be observable');
  assert.equal(failed.at(-1).detail.retrying, true);
  assert.equal(failed.at(-1).detail.sessionPreserved, true);
  assert.equal(maxConcurrent(), 1);
  await adapter.stop();
});

test('HTTP 500/502/503 responses are transient and do not end the session', async () => {
  const codes = [500, 502, 503];
  let polls = 0;
  const client = baseClient({
    async poll() {
      const index = polls;
      polls += 1;
      if (index < codes.length * 3) throw networkError(codes[index % codes.length]);
      return livePage({continuation: `NEXT-${polls}`});
    }
  });
  const adapter = adapterFor(client, {maxConsecutiveFailures: 2});
  const events = [];
  const ended = [];
  await adapter.start({onEvent: (event) => events.push(event), onEnd: (info) => ended.push(info)});
  await waitFor(() => events.length >= 1 || ended.length > 0 || polls >= 10);
  assert.equal(ended.length, 0);
  assert.ok(polls >= 10);
  assert.equal(adapter.state, 'connected');
  await adapter.stop();
});

test('HTTP 200 without continuationContents is an invalid response, never an end', async () => {
  const malformed = parseChatResponse({});
  let polls = 0;
  const client = baseClient({
    async poll() {
      polls += 1;
      if (polls === 1) return malformed;
      return livePage({continuation: `NEXT-${polls}`});
    }
  });
  const adapter = adapterFor(client, {maxConsecutiveFailures: 3});
  const events = [];
  const ended = [];
  const observer = collectStates();
  await adapter.start({
    onEvent: (event) => events.push(event),
    onEnd: (info) => ended.push(info),
    onStateChange: observer.onChange
  });
  await waitFor(() => events.length >= 1 || ended.length > 0 || polls >= 2);
  assert.equal(malformed.ended, false, 'the parser must not invent an end');
  assert.equal(malformed.invalid, true);
  assert.equal(ended.length, 0, 'a 200 with no continuationContents is ambiguous, not final');
  assert.ok(observer.states.some((entry) => entry.detail.code === YOUTUBE_ERRORS.WEB_RESPONSE_INVALID));
  assert.equal(adapter.state, 'connected');
  await adapter.stop();
});

test('structurally invalid 200 payloads never end the session', async () => {
  const shapes = [
    null,
    {},
    {continuationContents: null},
    {continuationContents: {}},
    {continuationContents: {liveChatContinuation: {}}},
    {continuationContents: {liveChatContinuation: {actions: [ACTION]}}}
  ].map((payload) => parseChatResponse(payload));
  let index = 0;
  let validPolls = 0;
  const client = baseClient({
    async poll() {
      if (index < shapes.length) {
        const page = shapes[index];
        index += 1;
        return page;
      }
      validPolls += 1;
      return livePage({continuation: `NEXT-${index}-${validPolls}`});
    }
  });
  const adapter = adapterFor(client, {maxConsecutiveFailures: 3});
  const events = [];
  const ended = [];
  await adapter.start({onEvent: (event) => events.push(event), onEnd: (info) => ended.push(info)});
  await waitFor(() => ended.length > 0 || (validPolls >= 1 && adapter.state === 'connected'));
  assert.equal(ended.length, 0);
  assert.ok(shapes.every((page) => page.invalid === true && page.ended === false));
  assert.equal(adapter.state, 'connected');
  await adapter.stop();
});

test('a stale continuation is refreshed; a failed refresh does not poll the same stale token again', async () => {
  let opens = 0;
  let polls = 0;
  const client = baseClient({
    async openChat() {
      opens += 1;
      if (opens >= 2 && opens <= 3) throw networkError(502);
      return {continuation: `CONT-${opens}`, actions: [], timeoutMs: 20, gl: 'US', config: {}};
    },
    async poll() {
      polls += 1;
      if (polls === 1) {
        throw new YouTubeApiError(YOUTUBE_ERRORS.WEB_STALE, {
          messageKey: 'errors.youtubeWebStale',
          httpStatus: 409
        });
      }
      return livePage({continuation: `NEXT-${polls}`});
    }
  });
  const adapter = adapterFor(client, {maxConsecutiveFailures: 6});
  const events = [];
  const ended = [];
  await adapter.start({onEvent: (event) => events.push(event), onEnd: (info) => ended.push(info)});
  await waitFor(() => events.length >= 1 || ended.length > 0 || opens >= 5);
  assert.equal(ended.length, 0);
  assert.equal(opens, 4, 'the chat page is reopened until it succeeds');
  assert.equal(polls, 2, 'the adapter must not keep polling a continuation it knows is stale');
  assert.equal(adapter.state, 'connected');
  await adapter.stop();
});

test('one ended or ordinary-video watch page read never ends; two ended reads end exactly once', async () => {
  let mode = 'video';
  let videoReads = 0;
  const client = baseClient({
    async getVideo() {
      videoReads += 1;
      if (mode === 'video') return {...VIDEO, state: 'video', isLive: false};
      if (mode === 'ended') return {...VIDEO, state: 'ended', isLive: false};
      if (mode === 'live-once') {
        mode = 'live';
        return {...VIDEO, state: 'ended', isLive: false};
      }
      return {...VIDEO};
    }
  });
  const adapter = adapterFor(client, {
    maxConsecutiveFailures: 3,
    metadataIntervalMs: 5,
    endConfirmDelayMs: 20
  });
  const events = [];
  const ended = [];
  await adapter.start({onEvent: (event) => events.push(event), onEnd: (info) => ended.push(info)});
  await waitFor(() => videoReads >= 3 || ended.length > 0);
  assert.equal(ended.length, 0, 'an ordinary video or a single ended read is not enough');

  mode = 'live-once';
  await waitFor(() => videoReads >= 5);
  assert.equal(ended.length, 0, 'a contradictory live read must cancel the end confirmation');

  mode = 'ended';
  await waitFor(() => ended.length === 1);
  const firstPollCount = adapter.snapshot().detail.pollCount;
  assert.equal(ended[0].reason, 'platform_ended');
  assert.equal(adapter.state, 'stopped');
  await sleep(40);
  assert.equal(ended.length, 1, 'onEnd fires exactly once');
  assert.equal(adapter.snapshot().detail.pollCount, firstPollCount, 'polling stops after a confirmed end');
});

test('an explicit chat-ended page ends only after an independent second chat read', async () => {
  let opens = 0;
  let polls = 0;
  const client = baseClient({
    async openChat() {
      opens += 1;
      if (opens === 1) {
        return {continuation: 'CONT-1', actions: [], timeoutMs: 20, gl: 'US', config: {}};
      }
      throw new YouTubeApiError(YOUTUBE_ERRORS.CHAT_ENDED, {
        messageKey: 'errors.youtubeChatEnded',
        httpStatus: 410
      });
    },
    async poll() {
      polls += 1;
      if (polls === 1) {
        throw new YouTubeApiError(YOUTUBE_ERRORS.WEB_STALE, {
          messageKey: 'errors.youtubeWebStale',
          httpStatus: 409
        });
      }
      return livePage({continuation: `NEXT-${polls}`});
    }
  });
  const adapter = adapterFor(client, {maxConsecutiveFailures: 3});
  const ended = [];
  const platform = [];
  await adapter.start({
    onEvent: () => {},
    onEnd: (info) => ended.push(info),
    onPlatformStatus: (info) => platform.push(info)
  });
  await waitFor(() => ended.length === 1);
  assert.equal(opens, 3, 'the chat page is read twice before an explicit closure is trusted');
  assert.equal(ended[0].reason, 'chat_ended');
  assert.equal(platform.at(-1).status, 'unknown', 'an unconfirmed broadcast state is never faked');
  await sleep(30);
  assert.equal(ended.length, 1);
});

test('one explicit chat-ended read is not enough when the next chat read succeeds', async () => {
  let opens = 0;
  let polls = 0;
  const client = baseClient({
    async openChat() {
      opens += 1;
      if (opens === 2) {
        throw new YouTubeApiError(YOUTUBE_ERRORS.CHAT_ENDED, {
          messageKey: 'errors.youtubeChatEnded',
          httpStatus: 410
        });
      }
      return {continuation: `CONT-${opens}`, actions: [], timeoutMs: 20, gl: 'US', config: {}};
    },
    async poll() {
      polls += 1;
      if (polls === 1) {
        throw new YouTubeApiError(YOUTUBE_ERRORS.WEB_STALE, {
          messageKey: 'errors.youtubeWebStale',
          httpStatus: 409
        });
      }
      return livePage({continuation: `NEXT-${polls}`});
    }
  });
  const adapter = adapterFor(client, {maxConsecutiveFailures: 4});
  const events = [];
  const ended = [];
  await adapter.start({onEvent: (event) => events.push(event), onEnd: (info) => ended.push(info)});
  await waitFor(() => events.length >= 1);
  assert.equal(ended.length, 0, 'a contradictory second chat read must cancel the end');
  assert.equal(opens, 3);
  assert.equal(adapter.state, 'connected');
  await adapter.stop();
});

test('user stop cancels polling and does not emit a platform end', async () => {
  const client = baseClient();
  const adapter = adapterFor(client, {maxConsecutiveFailures: 3});
  const ended = [];
  await adapter.start({onEvent: () => {}, onEnd: (info) => ended.push(info)});
  await waitFor(() => adapter.snapshot().detail.pollCount >= 1);
  await adapter.stop();
  const polls = adapter.snapshot().detail.pollCount;
  assert.equal(adapter.state, 'stopped');
  assert.equal(ended.length, 0, 'a user stop is not a platform end');
  await sleep(30);
  assert.equal(adapter.snapshot().detail.pollCount, polls, 'no poll survives stop()');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {KuaishouAdapter} from '../../src/platforms/kuaishou/adapter.mjs';
import {KUAISHOU_ERRORS} from '../../src/platforms/kuaishou/errors.mjs';
import {createKuaishouFetch, comment, feed, KUAISHOU_T0} from '../fixtures/kuaishou.mjs';

const enabled = {enabled: true, status: 'internal-authorized', authorizationRequired: false};
const disabled = {enabled: false, status: 'authorization-required', authorizationRequired: true};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, {timeout = 3000, interval = 5, label = 'condition'} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`waitFor timeout: ${label}`);
    await sleep(interval);
  }
}

function makeAdapter({fetchImpl, options = {}, access = enabled, eid = 'abc12345', liveStreamId = 'L1'}) {
  return new KuaishouAdapter({
    eid,
    liveStreamId,
    sessionId: 'ses_adapter',
    access,
    fetchImpl,
    now: Date.now,
    options: {
      pollIntervalMs: 5,
      statusIntervalMs: 600000,
      maxConsecutiveFailures: 4,
      maxBackoffMs: 20,
      ...options
    }
  });
}

test('the adapter refuses to open any feed without authorised access', async () => {
  let calls = 0;
  const adapter = makeAdapter({
    access: disabled,
    fetchImpl: async () => {
      calls += 1;
      throw new Error('must not fetch');
    }
  });
  await assert.rejects(() => adapter.start({}), (error) => error.code === KUAISHOU_ERRORS.AUTHORIZATION_REQUIRED);
  assert.equal(calls, 0);
  assert.equal(adapter.state, 'idle');
});

test('the first batch becomes chat events; duplicates and gifts are not counted as chat', async () => {
  const fetchImpl = createKuaishouFetch({
    feeds: {
      L1: [feed({cursor: 'c2', feeds: [
        comment({userId: 12345, userName: '观众A', content: '你好', time: KUAISHOU_T0 + 1}),
        comment({userId: 12345, userName: '观众A', content: '你好', time: KUAISHOU_T0 + 1}),
        {type: 'gift', content: '', time: KUAISHOU_T0 + 2, author: {userId: 12345, userName: '观众A'}},
        comment({userId: 67890, userName: '观众B', content: 'second', time: KUAISHOU_T0 + 3})
      ]})]
    }
  });
  const adapter = makeAdapter({fetchImpl});
  const events = [];
  const states = [];
  await adapter.start({onEvent: (event) => events.push(event), onStateChange: (state) => states.push(state.state)});
  try {
    assert.equal(adapter.state, 'connected');
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => event.content), ['你好', 'second']);
    assert.equal(events[0].viewer_uid, 'h5:12345@ses_adapter');
    assert.equal(events[0].external_id, null);
    const capture = adapter.capture();
    assert.equal(capture.category, 'normal');
    assert.equal(capture.chats, 2);
    assert.equal(capture.duplicates, 1);
    assert.equal(capture.ignored, 1);
    assert.equal(capture.identity.mode, 'session-provisional');
    assert.equal(capture.identity.stableUserId, 'unproven');
    assert.equal(capture.identity.messageId, false);
    assert.ok(states.includes('connecting'));
    assert.ok(states.includes('connected'));
  } finally {
    await adapter.stop({reason: 'test'});
  }
});

test('a rate-limited batch is retried with backoff instead of being treated as success', async () => {
  const fetchImpl = createKuaishouFetch({
    feeds: {
      L1: [
        feed({cursor: 'c1', feeds: [comment()]}),
        feed({result: 2, feeds: []}),
        feed({cursor: 'c2', feeds: [comment({content: 'after limit', time: KUAISHOU_T0 + 9})]})
      ]
    }
  });
  const adapter = makeAdapter({fetchImpl});
  const events = [];
  await adapter.start({onEvent: (event) => events.push(event)});
  try {
    await waitFor(() => adapter.state === 'connected' && events.length === 2, {label: 'recovered after rate limit'});
    assert.ok(adapter.capture().counters.rateLimited >= 1);
    assert.ok(adapter.capture().reconnects >= 1);
  } finally {
    await adapter.stop({reason: 'test'});
  }
});

test('a network drop reconnects and keeps the session, with an observable gap flag', async () => {
  let feedCalls = 0;
  const base = createKuaishouFetch({feeds: {L1: [feed({cursor: 'c1', feeds: [comment()]})]}});
  const fetchImpl = async (url) => {
    if (String(url).includes('/wap/live/feed')) {
      feedCalls += 1;
      if (feedCalls === 2) throw Object.assign(new Error('drop'), {name: 'TypeError'});
    }
    return base(url);
  };
  const adapter = makeAdapter({fetchImpl});
  const states = [];
  await adapter.start({onStateChange: (state) => states.push(state.state)});
  try {
    assert.equal(adapter.state, 'connected');
    await waitFor(() => states.includes('reconnecting'), {label: 'entered reconnecting'});
    await waitFor(() => adapter.state === 'connected' && adapter.capture().reconnects >= 1, {label: 'recovered'});
    assert.equal(adapter.capture().possibleGap, true);
  } finally {
    await adapter.stop({reason: 'test'});
  }
});

test('feed result 601 ends the capture and reports the real reason', async () => {
  const fetchImpl = createKuaishouFetch({
    feeds: {L1: [feed({feeds: [comment()]}), feed({result: 601, feeds: []})]}
  });
  const adapter = makeAdapter({fetchImpl});
  let ended = null;
  await adapter.start({onEnd: (info) => { ended = info; }});
  await waitFor(() => ended, {label: 'platform end', timeout: 4000});
  assert.equal(ended.reason, 'platform_ended');
  assert.equal(adapter.state, 'stopped');
  assert.equal(adapter.capture().category, 'ended');
});

test('two consecutive room-page offline checks end the capture; a rate limit or unknown page does not', async () => {
  const offline = createKuaishouFetch({rooms: {abc12345: {}}, feeds: {L1: [feed({feeds: []})]}});
  const ended = [];
  const offlineAdapter = makeAdapter({
    fetchImpl: offline,
    options: {statusIntervalMs: 15}
  });
  await offlineAdapter.start({onEnd: (info) => ended.push(info)});
  await waitFor(() => ended.length > 0, {label: 'offline end', timeout: 4000});
  assert.equal(ended[0].reason, 'platform_ended');

  for (const room of [{rateLimited: true}, {generic: true}]) {
    const limited = createKuaishouFetch({rooms: {abc12345: room}, feeds: {L1: [feed({feeds: []})]}});
    const limitedEnded = [];
    const limitedAdapter = makeAdapter({fetchImpl: limited, options: {statusIntervalMs: 15}});
    await limitedAdapter.start({onEnd: (info) => limitedEnded.push(info)});
    await sleep(120);
    assert.equal(limitedEnded.length, 0, JSON.stringify(room));
    assert.equal(limitedAdapter.state, 'connected');
    await limitedAdapter.stop({reason: 'test'});
  }
});

test('stop is final and ignores a late polling result', async () => {
  const fetchImpl = createKuaishouFetch({feeds: {L1: [feed({feeds: [comment()]})]}});
  const adapter = makeAdapter({fetchImpl});
  const events = [];
  await adapter.start({onEvent: (event) => events.push(event)});
  const before = events.length;
  await adapter.stop({reason: 'user'});
  await sleep(50);
  assert.equal(events.length, before, 'no event is accepted after stop');
  assert.equal(adapter.state, 'stopped');
  assert.equal(adapter.capture().category, 'stopped');
});

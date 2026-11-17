import test from 'node:test';
import assert from 'node:assert/strict';

import {KuaishouFeedClient} from '../../src/platforms/kuaishou/transport.mjs';
import {KUAISHOU_ERRORS} from '../../src/platforms/kuaishou/errors.mjs';
import {KUAISHOU_T0, comment, feed} from '../fixtures/kuaishou.mjs';

function clientWith(body, {status = 200} = {}) {
  const calls = [];
  const client = new KuaishouFeedClient({
    eid: 'abc12345',
    liveStreamId: 'L1',
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        status,
        url,
        headers: new Headers(),
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
      };
    }
  });
  return {client, calls};
}

test('the feed URL carries liveStreamId and the cursor', () => {
  const {client} = clientWith(feed({feeds: []}));
  const url = new URL(client.feedUrl('cursor-1'));
  assert.equal(url.origin, 'https://livev.m.chenzhongtech.com');
  assert.equal(url.pathname, '/wap/live/feed');
  assert.equal(url.searchParams.get('liveStreamId'), 'L1');
  assert.equal(url.searchParams.get('cursor'), 'cursor-1');
});

test('a successful batch returns comments, the next cursor and result 1', async () => {
  const {client, calls} = clientWith(feed({cursor: 'next', feeds: [comment({content: 'hello'})]}));
  const batch = await client.poll('');
  assert.equal(batch.result, 1);
  assert.equal(batch.cursor, 'next');
  assert.equal(batch.feeds.length, 1);
  assert.equal(batch.feeds[0].content, 'hello');
  assert.match(calls[0], /cursor=/);
});

test('terminal platform results are classified, never treated as success', async () => {
  const cases = [
    [601, KUAISHOU_ERRORS.ROOM_OFFLINE],
    [671, KUAISHOU_ERRORS.ROOM_OFFLINE],
    [2, KUAISHOU_ERRORS.RATE_LIMITED],
    [109, KUAISHOU_ERRORS.ACCESS_DENIED],
    [22, KUAISHOU_ERRORS.ROOM_NOT_FOUND],
    [400002, KUAISHOU_ERRORS.RISK_CONTROL],
    [999, KUAISHOU_ERRORS.UPSTREAM]
  ];
  for (const [result, code] of cases) {
    const {client} = clientWith({result, error_msg: 'x'});
    await assert.rejects(() => client.poll(''), (error) => error.code === code, `result ${result}`);
  }
});

test('malformed responses are protocol errors, not empty captures', async () => {
  for (const body of ['not json', {}, {result: null}, {result: 1, liveStreamFeeds: 'nope'}]) {
    const {client} = clientWith(body);
    try {
      const batch = await client.poll('');
      // `{result:1, liveStreamFeeds:'nope'}` is a valid empty batch by design,
      // but every other shape above must throw.
      assert.deepEqual(batch.feeds, []);
      assert.equal(body.result, 1);
    } catch (error) {
      assert.equal(error.code, KUAISHOU_ERRORS.PROTOCOL, JSON.stringify(body));
    }
  }
});

test('HTTP failures map to the right error class', async () => {
  for (const [status, code] of [[429, KUAISHOU_ERRORS.RATE_LIMITED], [403, KUAISHOU_ERRORS.ACCESS_DENIED], [404, KUAISHOU_ERRORS.ROOM_NOT_FOUND], [500, KUAISHOU_ERRORS.HTTP]]) {
    const {client} = clientWith({result: 1}, {status});
    await assert.rejects(() => client.poll(''), (error) => error.code === code, `HTTP ${status}`);
  }
});

test('a network failure is surfaced as NETWORK', async () => {
  const client = new KuaishouFeedClient({
    eid: 'abc12345',
    liveStreamId: 'L1',
    fetchImpl: async () => {
      throw Object.assign(new Error('offline'), {name: 'TypeError'});
    }
  });
  await assert.rejects(() => client.poll(''), (error) => error.code === KUAISHOU_ERRORS.NETWORK);
});

test('a timeout is surfaced as TIMEOUT', async () => {
  const client = new KuaishouFeedClient({
    eid: 'abc12345',
    liveStreamId: 'L1',
    fetchImpl: async () => {
      throw Object.assign(new Error('timeout'), {name: 'TimeoutError'});
    }
  });
  await assert.rejects(() => client.poll(''), (error) => error.code === KUAISHOU_ERRORS.TIMEOUT);
});

test('the client refuses to be constructed without a room and stream id', () => {
  assert.throws(() => new KuaishouFeedClient({eid: '', liveStreamId: 'L1'}), (error) => error.code === KUAISHOU_ERRORS.NOT_CONFIGURED);
  assert.throws(() => new KuaishouFeedClient({eid: 'abc12345'}), (error) => error.code === KUAISHOU_ERRORS.NOT_CONFIGURED);
});

test('a replayed batch is returned as-is; dedupe belongs to the adapter', async () => {
  const {client} = clientWith(feed({feeds: [comment({content: 'same', time: KUAISHOU_T0})]}));
  const first = await client.poll('');
  const second = await client.poll('');
  assert.deepEqual(first.feeds[0], second.feeds[0]);
});

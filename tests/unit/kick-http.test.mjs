import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {KickHttp, __internal} from '../../src/platforms/kick/http.mjs';
import {KICK_ERRORS} from '../../src/platforms/kick/errors.mjs';

function httpWith(handler) {
  const calls = [];
  const http = new KickHttp({
    request: async (options) => {
      calls.push(options);
      return handler(options, calls.length);
    }
  });
  return {http, calls};
}

const ok = (body) => ({status: 200, headers: {}, body: Buffer.from(JSON.stringify(body))});

test('parses a JSON response and never reads a body twice', async () => {
  const {http, calls} = httpWith(() => ok({data: {id: 1}}));
  const response = await http.requestJson('https://kick.com/api/v2/channels/xqc');
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, {data: {id: 1}});
  assert.equal(calls.length, 1);
  assert.match(calls[0].headers['user-agent'], /Mozilla\/5\.0/);
  assert.equal(calls[0].headers.origin, 'https://kick.com');
});

test('a 403 is reported as KICK_BLOCKED, never retried as success', async () => {
  const {http, calls} = httpWith(() => ({status: 403, headers: {}, body: Buffer.from('{"error":"Request blocked by security policy."}')}));
  await assert.rejects(
    () => http.requestJson('https://kick.com/x'),
    (error) => error.code === KICK_ERRORS.BLOCKED && error.details.reason === 'security_policy'
  );
  assert.equal(calls.length, 1);
  assert.equal(http.snapshot().errorCount, 1);
});

test('a 429 keeps the retry delay but is not treated as a capture', async () => {
  const {http} = httpWith(() => ({status: 429, headers: {'retry-after': '7'}, body: Buffer.from('{}')}));
  await assert.rejects(
    () => http.requestJson('https://kick.com/x'),
    (error) => error.code === KICK_ERRORS.RATE_LIMITED && error.retryAfterMs === 7000
  );
});

test('a 5xx is a network failure, not a block', async () => {
  const {http} = httpWith(() => ({status: 503, headers: {}, body: Buffer.from('unavailable')}));
  await assert.rejects(
    () => http.requestJson('https://kick.com/x'),
    (error) => error.code === KICK_ERRORS.NETWORK
  );
});

test('a 404 is returned to the caller to map (room vs endpoint)', async () => {
  const {http} = httpWith(() => ({status: 404, headers: {}, body: Buffer.from('{"message":""}')}));
  const response = await http.requestJson('https://kick.com/api/v2/channels/nobody');
  assert.equal(response.status, 404);
  assert.equal(response.data.message, '');
});

test('a redirect is followed once to the new location', async () => {
  const {http, calls} = httpWith((options, index) => (
    index === 1
      ? {status: 302, headers: {location: '/api/v2/channels/renamed'}, body: Buffer.from('')}
      : ok({id: 9})
  ));
  const response = await http.requestJson('https://kick.com/api/v2/channels/old');
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, {id: 9});
  assert.equal(calls[1].url, 'https://kick.com/api/v2/channels/renamed');
});

test('a closed client refuses new requests and body decoding handles gzip', async () => {
  const {http} = httpWith(() => ok({}));
  await http.close();
  await assert.rejects(() => http.requestJson('https://kick.com/x'), (error) => error.code === KICK_ERRORS.STOPPED);
  assert.equal(__internal.decodeBody(gzipSync(Buffer.from('{"a":1}')), 'gzip').toString('utf8'), '{"a":1}');
  assert.equal(__internal.decodeBody(Buffer.from('plain'), 'identity').toString('utf8'), 'plain');
});

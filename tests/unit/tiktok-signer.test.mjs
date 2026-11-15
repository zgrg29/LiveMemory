import test from 'node:test';
import assert from 'node:assert/strict';
import {TikTokSigner, DEFAULT_SIGN_BASE_URL} from '../../src/platforms/tiktok/signer.mjs';
import {chatMessage, fetchResult} from '../helpers/tiktok-frames.mjs';

function protobufResponse(buffer, {status = 200, headers = {}} = {}) {
  return new Response(buffer, {status, headers: {'content-type': 'application/protobuf', ...headers}});
}

test('the signer calls the free community connect endpoint with the documented client id', async () => {
  let seen = null;
  let seenHeaders = null;
  const signer = new TikTokSigner({
    fetchImpl: async (url, init) => {
      seen = String(url);
      seenHeaders = init.headers;
      return protobufResponse(fetchResult({messages: [{method: 'WebcastChatMessage', payload: chatMessage()}]}), {
        headers: {'x-set-tt-cookie': 'ttwid=abc', 'x-room-id': '999'}
      });
    }
  });
  const result = await signer.connect({roomId: '7700000000000000001'});
  assert.ok(seen.startsWith(`${DEFAULT_SIGN_BASE_URL}/webcast/rooms/7700000000000000001/connect?`));
  assert.match(seen, /client=ttlive-node/);
  assert.match(seen, /client_enter=true/);
  assert.match(seen, /platform=web/);
  assert.equal(seenHeaders['x-api-key'], undefined);
  assert.equal(result.cookie, 'ttwid=abc');
  assert.equal(result.roomId, '999');
  assert.equal(result.fetchResult.messages.length, 1);
  assert.equal(result.fetchResult.cursor, 'cursor-1');
});

test('a cursor is forwarded so batches continue instead of restarting', async () => {
  let seen = null;
  const signer = new TikTokSigner({
    fetchImpl: async (url) => {
      seen = String(url);
      return protobufResponse(fetchResult({cursor: 'next-cursor'}));
    }
  });
  await signer.connect({roomId: '7700000000000000001', cursor: 'prev-cursor'});
  assert.match(seen, /cursor=prev-cursor/);
});

test('an API key is optional and sent as a header only when configured', async () => {
  let seenHeaders = null;
  const signer = new TikTokSigner({
    apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      seenHeaders = init.headers;
      return protobufResponse(fetchResult());
    }
  });
  assert.equal(signer.mode, 'community-signer-with-key');
  await signer.connect({roomId: '7700000000000000001'});
  assert.equal(seenHeaders['x-api-key'], 'test-key');
});

test('HTTP 429 maps to a rate-limit error and keeps the retry delay', async () => {
  const signer = new TikTokSigner({
    fetchImpl: async () => protobufResponse(Buffer.from('{}'), {status: 429, headers: {'retry-after': '7'}})
  });
  await assert.rejects(() => signer.connect({roomId: '7700000000000000001'}), (error) => {
    assert.equal(error.code, 'TIKTOK_RATE_LIMITED');
    assert.equal(error.retryAfterMs, 7000);
    return true;
  });
});

test('a provider that refuses the free plan is surfaced, never retried as success', async () => {
  for (const status of [401, 402, 403]) {
    const signer = new TikTokSigner({
      fetchImpl: async () => protobufResponse(Buffer.from('{"message":"This endpoint requires a Business plan"}'), {status})
    });
    await assert.rejects(() => signer.connect({roomId: '7700000000000000001'}), (error) => {
      assert.equal(error.code, 'TIKTOK_SIGNER_PREMIUM_REQUIRED');
      assert.match(String(error.details?.providerMessage ?? ''), /Business plan/);
      return true;
    });
  }
});

test('an empty or cursor-less body is a protocol failure, not an empty live stream', async () => {
  const empty = new TikTokSigner({fetchImpl: async () => protobufResponse(Buffer.alloc(0))});
  await assert.rejects(() => empty.connect({roomId: '7700000000000000001'}), (error) => error.code === 'TIKTOK_SIGNER_UNAVAILABLE');
  const noCursor = new TikTokSigner({fetchImpl: async () => protobufResponse(fetchResult({cursor: ''}))});
  await assert.rejects(() => noCursor.connect({roomId: '7700000000000000001'}), (error) => error.code === 'TIKTOK_PROTOCOL');
});

test('an invalid room id is rejected before any network call', async () => {
  let called = false;
  const signer = new TikTokSigner({
    fetchImpl: async () => {
      called = true;
      return protobufResponse(fetchResult());
    }
  });
  await assert.rejects(() => signer.connect({roomId: 'abc'}), (error) => error.code === 'TIKTOK_PROTOCOL');
  assert.equal(called, false);
});

test('a custom signer base URL is honored (self-hosted compatible provider)', async () => {
  let seen = null;
  const signer = new TikTokSigner({
    baseUrl: 'https://sign.example.test/',
    fetchImpl: async (url) => {
      seen = String(url);
      return protobufResponse(fetchResult());
    }
  });
  await signer.connect({roomId: '7700000000000000001'});
  assert.ok(seen.startsWith('https://sign.example.test/webcast/rooms/'));
});

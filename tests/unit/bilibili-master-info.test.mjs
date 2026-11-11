import test from 'node:test';
import assert from 'node:assert/strict';
import {BilibiliApi} from '../../src/platforms/bilibili/api.mjs';

test('masterInfo reads the public anchor name without a login cookie', async () => {
  let seen = null;
  const api = new BilibiliApi({
    fetchImpl: async (url, options) => {
      seen = {url, options};
      return Response.json({code: 0, data: {info: {uid: 4242, uname: 'Real Anchor'}}});
    }
  });
  const result = await api.masterInfo(4242);
  assert.deepEqual(result, {name: 'Real Anchor', uid: 4242});
  assert.match(seen.url, /\/live_user\/v1\/Master\/info\?uid=4242$/);
  assert.equal('Authorization' in seen.options.headers, false);
  assert.equal('Cookie' in seen.options.headers, false);
});

test('masterInfo ignores invalid uids instead of inventing a request', async () => {
  let calls = 0;
  const api = new BilibiliApi({
    fetchImpl: async () => {
      calls += 1;
      return Response.json({code: 0, data: {}});
    }
  });
  assert.deepEqual(await api.masterInfo('not-an-uid'), {name: null, uid: null});
  assert.equal(calls, 0);
});

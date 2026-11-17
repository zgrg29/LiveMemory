import test from 'node:test';
import assert from 'node:assert/strict';

import {parseKuaishouInput} from '../../src/platforms/kuaishou/link.mjs';
import {KUAISHOU_ERRORS} from '../../src/platforms/kuaishou/errors.mjs';

test('Kuaishou link parsing accepts the verified live-room forms', () => {
  assert.deepEqual(parseKuaishouInput('https://live.kuaishou.com/u/abc12345'), {
    eid: 'abc12345',
    source: 'live-url',
    liveUrl: 'https://live.kuaishou.com/u/abc12345',
    h5ShareUrl: 'https://livev.m.chenzhongtech.com/fw/live/abc12345'
  });
  assert.equal(parseKuaishouInput('https://live.kuaishou.com/u/abc12345/?fid=1&cc=share').eid, 'abc12345');
  assert.equal(parseKuaishouInput('https://livev.m.chenzhongtech.com/fw/live/abc12345').source, 'h5-share-url');
  assert.equal(parseKuaishouInput('3xtgiecv6inq83i').source, 'bare-id');
  assert.equal(parseKuaishouInput('  https://LIVE.KUAISHOU.COM/u/abc12345  ').eid, 'abc12345');
});

test('Kuaishou link parsing rejects profiles, videos, replays and other platforms', () => {
  const rejected = [
    '',
    '   ',
    'https://www.kuaishou.com/short-video/3xabc',
    'https://www.kuaishou.com/profile/3xabc',
    'https://live.kuaishou.com/profile/3xabc',
    'https://live.kuaishou.com/u/',
    'https://live.kuaishou.com/u/ab',
    'https://livev.m.chenzhongtech.com/fw/live/',
    'https://example.com/u/abc12345',
    'https://www.tiktok.com/@someone/live',
    'ftp://live.kuaishou.com/u/abc12345',
    'https://user:pass@live.kuaishou.com/u/abc12345'
  ];
  for (const input of rejected) {
    assert.throws(
      () => parseKuaishouInput(input),
      (error) => error.code === KUAISHOU_ERRORS.LINK_INVALID,
      `expected ${JSON.stringify(input)} to be rejected`
    );
  }
});

test('the parser never performs a network request', () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('network must not be used by the parser');
  };
  try {
    assert.equal(parseKuaishouInput('https://live.kuaishou.com/u/abc12345').eid, 'abc12345');
  } finally {
    globalThis.fetch = original;
  }
});

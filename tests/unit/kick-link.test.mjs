import test from 'node:test';
import assert from 'node:assert/strict';
import {parseKickInput, slugFromUrl, kickChannelUrl} from '../../src/platforms/kick/link.mjs';
import {KICK_ERRORS} from '../../src/platforms/kick/errors.mjs';

test('accepts Kick channel links, the /chat route and a bare slug', () => {
  assert.deepEqual(
    parseKickInput('https://kick.com/odablock'),
    {slug: 'odablock', url: 'https://kick.com/odablock', liveUrl: 'https://kick.com/odablock', input: 'https://kick.com/odablock'}
  );
  assert.equal(parseKickInput('https://www.kick.com/odablock/chat').slug, 'odablock');
  assert.equal(parseKickInput('http://kick.com/xqc?ref=share').slug, 'xqc');
  assert.equal(parseKickInput('m.kick.com/gmhikaru').slug, 'gmhikaru');
  assert.equal(parseKickInput('  gmhikaru  ').slug, 'gmhikaru');
  assert.equal(parseKickInput('/4head').slug, '4head');
  assert.equal(parseKickInput('a_b-c9').slug, 'a_b-c9');
});

test('rejects VOD, category, clip and site-section links instead of guessing a room', () => {
  const rejected = [
    'https://kick.com/video/9f8c1c1c-0000-4000-8000-000000000000',
    'https://kick.com/odablock/videos',
    'https://kick.com/odablock/clips',
    'https://kick.com/category/chess',
    'https://kick.com/categories',
    'https://kick.com/search?q=xqc',
    'https://kick.com/browse',
    'https://kick.com/dashboard',
    'https://kick.com/',
    'https://twitch.tv/odablock',
    'https://kick.com.evil.example/odablock'
  ];
  for (const input of rejected) {
    assert.equal(slugFromUrl(input), null, input);
    assert.throws(() => parseKickInput(input), (error) => error.code === KICK_ERRORS.LINK_INVALID, input);
  }
});

test('reserved first segments are not channel slugs', () => {
  for (const input of ['video', 'settings', 'search', 'about', 'Videos']) {
    assert.throws(() => parseKickInput(input), (error) => error.code === KICK_ERRORS.LINK_INVALID, input);
  }
});

test('malformed input fails with KICK_LINK_INVALID, never with a fabricated slug', () => {
  for (const input of ['', '   ', 'a b', '..', 'a/b', 'x'.repeat(80), 'https://kick.com/%2E%2E']) {
    assert.throws(() => parseKickInput(input), (error) => error.code === KICK_ERRORS.LINK_INVALID, input);
  }
});

test('channel URL builder is canonical', () => {
  assert.equal(kickChannelUrl('odablock'), 'https://kick.com/odablock');
  assert.equal(kickChannelUrl('/odablock'), 'https://kick.com/odablock');
});

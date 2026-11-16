import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTikTokInput, tiktokLiveUrl, uniqueIdFromUrl} from '../../src/platforms/tiktok/link.mjs';

test('accepts the canonical TikTok live URL', () => {
  const parsed = parseTikTokInput('https://www.tiktok.com/@aljazeeraenglish/live');
  assert.equal(parsed.uniqueId, 'aljazeeraenglish');
  assert.equal(parsed.liveUrl, 'https://www.tiktok.com/@aljazeeraenglish/live');
});

test('accepts a creator page URL, an @handle and a bare handle', () => {
  assert.equal(parseTikTokInput('https://www.tiktok.com/@shetu.khan2').uniqueId, 'shetu.khan2');
  assert.equal(parseTikTokInput('@aljazeeraenglish').uniqueId, 'aljazeeraenglish');
  assert.equal(parseTikTokInput('aljazeeraenglish').uniqueId, 'aljazeeraenglish');
  assert.equal(uniqueIdFromUrl('https://m.tiktok.com/@aljazeeraenglish/live?lang=en'), 'aljazeeraenglish');
});

test('rejects videos, photos, short links, search and other hosts', () => {
  for (const input of [
    'https://www.tiktok.com/@aljazeeraenglish/video/7300000000000000000',
    'https://www.tiktok.com/@aljazeeraenglish/photo/7300000000000000000',
    'https://vm.tiktok.com/ZMabc/',
    'https://www.tiktok.com/search?q=live',
    'https://www.tiktok.com/tag/live',
    'https://example.com/@aljazeeraenglish/live',
    '',
    '   '
  ]) {
    assert.throws(() => parseTikTokInput(input), (error) => error.code === 'TIKTOK_LINK_INVALID', input);
  }
});

test('rejects a handle with characters TikTok does not allow', () => {
  assert.throws(() => parseTikTokInput('@bad handle'), (error) => error.code === 'TIKTOK_LINK_INVALID');
  assert.throws(() => parseTikTokInput('@a'), (error) => error.code === 'TIKTOK_LINK_INVALID');
});

test('tiktokLiveUrl normalizes the handle', () => {
  assert.equal(tiktokLiveUrl('@aljazeeraenglish'), 'https://www.tiktok.com/@aljazeeraenglish/live');
});

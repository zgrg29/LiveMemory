import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDouyinInput,
  extractDouyinWebRid,
  normalizeWebRid
} from '../../src/platforms/douyin/link.mjs';

test('a live room URL or a bare numeric web_rid resolves to the same room', () => {
  const fromUrl = parseDouyinInput('https://live.douyin.com/708764876300');
  assert.equal(fromUrl.webRid, '708764876300');
  assert.equal(fromUrl.normalizedUrl, 'https://live.douyin.com/708764876300');
  assert.equal(parseDouyinInput('708764876300').webRid, '708764876300');
  assert.equal(parseDouyinInput('https://live.douyin.com/708764876300/?enter_from=x').webRid, '708764876300');
});

test('the current share form /root/live/<rid> is accepted on www.douyin.com', () => {
  const parsed = parseDouyinInput('https://www.douyin.com/root/live/708764876300');
  assert.equal(parsed.webRid, '708764876300');
  assert.equal(parsed.form, 'share');
});

test('user, video and search pages are rejected instead of being guessed into a room', () => {
  for (const input of [
    'https://www.douyin.com/user/MS4wLjABAAAA',
    'https://www.douyin.com/video/1234567890123456789',
    'https://www.douyin.com/search/abc',
    'https://live.douyin.com/user/123',
    'https://v.douyin.com/abcdef/',
    'https://example.com/live/123456789',
    'live',
    ''
  ]) {
    assert.throws(() => parseDouyinInput(input), (error) => error.code === 'DOUYIN_LINK_INVALID', input);
    assert.equal(extractDouyinWebRid(input), null);
  }
});

test('room ids are validated and never normalised through a nickname', () => {
  assert.equal(normalizeWebRid(' 708764876300 '), '708764876300');
  assert.equal(normalizeWebRid('abc'), null);
  assert.equal(normalizeWebRid('12'), null);
  assert.equal(normalizeWebRid('1'.repeat(21)), null);
});

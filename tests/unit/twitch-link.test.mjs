import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTwitchInput, extractTwitchLogin} from '../../src/platforms/twitch/link.mjs';

test('a bare Twitch login is normalised to lower case', () => {
  const parsed = parseTwitchInput('xQc');
  assert.equal(parsed.login, 'xqc');
  assert.equal(parsed.form, 'login');
  assert.equal(parsed.normalizedUrl, 'https://www.twitch.tv/xqc');
});

test('channel URLs on twitch.tv, www, m and go are accepted', () => {
  for (const input of [
    'https://twitch.tv/shroud',
    'https://www.twitch.tv/shroud/',
    'https://m.twitch.tv/shroud?tt_content=channel',
    'https://go.twitch.tv/shroud',
    'www.twitch.tv/shroud'
  ]) {
    const parsed = parseTwitchInput(input);
    assert.equal(parsed.login, 'shroud', input);
    assert.equal(parsed.form, 'channel', input);
  }
});

test('popout URLs and player channel parameters are accepted', () => {
  assert.equal(parseTwitchInput('https://www.twitch.tv/popout/shroud/chat').login, 'shroud');
  assert.equal(parseTwitchInput('https://player.twitch.tv/?channel=shroud&parent=example.com').login, 'shroud');
  assert.equal(parseTwitchInput('https://www.twitch.tv/?channel=shroud').login, 'shroud');
});

test('non-channel Twitch links are rejected', () => {
  for (const input of [
    'https://www.twitch.tv/videos/1234567890',
    'https://www.twitch.tv/shroud/videos',
    'https://www.twitch.tv/directory/game/Just%20Chatting',
    'https://www.twitch.tv/search?term=xqc',
    'https://clips.twitch.tv/SomeClip',
    'https://example.com/shroud',
    'https://www.twitch.tv/',
    'https://www.twitch.tv/a',
    'https://www.twitch.tv/this_name_is_far_too_long_for_twitch',
    '',
    'not a channel'
  ]) {
    assert.throws(() => parseTwitchInput(input), {code: 'TWITCH_LINK_INVALID'}, input);
  }
});

test('extractTwitchLogin returns null instead of throwing', () => {
  assert.equal(extractTwitchLogin('twitch.tv/ludwig'), 'ludwig');
  assert.equal(extractTwitchLogin('https://www.twitch.tv/videos/1'), null);
});

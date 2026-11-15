import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeTagValue,
  parseBadgesTag,
  parseEmotesTag,
  parseIrcLine,
  parseIrcPayload,
  parseTagSection,
  stripActionWrapper,
  unescapeTagValue
} from '../../src/platforms/twitch/irc.mjs';

test('IRCv3 tag values decode every documented escape', () => {
  assert.equal(unescapeTagValue('a\\sb\\:c\\\\d\\re\\nf'), 'a b;c\\d\re\nf');
  assert.equal(unescapeTagValue('plain value'), 'plain value');
  // Unknown escapes are preserved rather than dropped.
  assert.equal(unescapeTagValue('a\\qb'), 'a\\qb');
});

test('tag values round-trip through the escaper', () => {
  const original = 'hello world; path\\name';
  assert.equal(unescapeTagValue(escapeTagValue(original)), original);
});

test('a tagged PRIVMSG keeps its tags, prefix, target and full trailing text', () => {
  const line = '@badge-info=;badges=moderator/1,subscriber/12;color=#1E90FF;display-name=Alice\\sW;'
    + 'emotes=25:0-4;id=abc-123;login=alice;mod=1;room-id=42;tmi-sent-ts=1700000000123;'
    + 'user-id=1001 :alice!alice@alice.tmi.twitch.tv PRIVMSG #xqc :hello 😂 world: still here';
  const parsed = parseIrcLine(line);
  assert.equal(parsed.command, 'PRIVMSG');
  assert.equal(parsed.tags['display-name'], 'Alice W');
  assert.equal(parsed.tags['user-id'], '1001');
  assert.equal(parsed.tags.id, 'abc-123');
  assert.equal(parsed.nick, 'alice');
  assert.equal(parsed.params[0], '#xqc');
  assert.equal(parsed.trailing, 'hello 😂 world: still here');
});

test('tags are parsed even without a prefix', () => {
  const tags = parseTagSection('a=1;b=two\\sthree;flag');
  assert.deepEqual(tags, {a: '1', b: 'two three', flag: ''});
});

test('a batched WebSocket frame is split into independent IRC lines', () => {
  const payload = 'PING :tmi.twitch.tv\r\n'
    + '@id=1;user-id=9;display-name=Bob;room-id=42;tmi-sent-ts=1700000000000 :bob!bob@bob.tmi.twitch.tv PRIVMSG #xqc :one\r\n'
    + '@room-id=42 :tmi.twitch.tv ROOMSTATE #xqc\r\n';
  const lines = parseIrcPayload(payload);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].command, 'PING');
  assert.equal(lines[0].trailing, 'tmi.twitch.tv');
  assert.equal(lines[1].command, 'PRIVMSG');
  assert.equal(lines[1].trailing, 'one');
  assert.equal(lines[2].command, 'ROOMSTATE');
  assert.equal(lines[2].tags['room-id'], '42');
});

test('the emotes tag preserves emote ids and their ranges', () => {
  const emotes = parseEmotesTag('25:0-4,6-10/1902:12-14');
  assert.equal(emotes.length, 2);
  assert.equal(emotes[0].id, '25');
  assert.deepEqual(emotes[0].ranges, [{start: 0, end: 4}, {start: 6, end: 10}]);
  assert.equal(emotes[1].id, '1902');
  assert.deepEqual(parseEmotesTag(''), []);
  assert.deepEqual(parseEmotesTag('bad'), []);
});

test('badges map to the small canonical set and keep subscriber months', () => {
  const badges = parseBadgesTag('broadcaster/1,moderator/1,subscriber/12,vip/1', 'subscriber/12');
  assert.deepEqual(badges[0], {type: 'owner', label: 'Broadcaster'});
  assert.deepEqual(badges[1], {type: 'moderator', label: 'Moderator'});
  assert.equal(badges[2].type, 'member');
  assert.equal(badges[2].label, 'Subscriber 12');
  assert.deepEqual(badges.at(-1), {type: 'unknown', label: 'VIP'});
});

test('the /me ACTION wrapper is removed without touching other text', () => {
  assert.equal(stripActionWrapper('\u0001ACTION waves hello\u0001'), 'waves hello');
  assert.equal(stripActionWrapper('normal message'), 'normal message');
  assert.equal(stripActionWrapper('\u0001ACTION\u0001'), '\u0001ACTION\u0001');
});

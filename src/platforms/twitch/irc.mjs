/**
 * Minimal Twitch IRCv3 parser.
 *
 * Twitch's chat gateway uses IRCv3 message tags. Values are escaped with a
 * backslash; the message body itself is UTF-8 and is preserved exactly (apart
 * from the ACTION wrapper used by `/me`). No third-party IRC library is needed,
 * which keeps the runtime dependency-free and Node SEA friendly.
 *
 * This module is pure: it never opens a socket and never touches storage.
 */

const TAG_ESCAPES = Object.freeze({
  ':': ';',
  s: ' ',
  '\\': '\\',
  r: '\r',
  n: '\n'
});

/** Decode one IRCv3 tag value (`\\s`, `\\:`, `\\\\`, `\\r`, `\\n`). */
export function unescapeTagValue(value) {
  const text = String(value ?? '');
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '\\') {
      output += char;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) {
      output += '\\';
      continue;
    }
    if (Object.hasOwn(TAG_ESCAPES, next)) {
      output += TAG_ESCAPES[next];
      index += 1;
      continue;
    }
    // Unknown escapes are kept verbatim rather than silently dropped.
    output += `\\${next}`;
    index += 1;
  }
  return output;
}

export function escapeTagValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\:')
    .replace(/ /g, '\\s')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * @param {string} raw tag section without the leading `@`
 * @returns {Record<string,string>}
 */
export function parseTagSection(raw) {
  const tags = {};
  if (!raw) return tags;
  for (const pair of String(raw).split(';')) {
    if (!pair) continue;
    const equals = pair.indexOf('=');
    if (equals < 0) {
      tags[pair] = '';
      continue;
    }
    const key = pair.slice(0, equals);
    if (!key) continue;
    tags[key] = unescapeTagValue(pair.slice(equals + 1));
  }
  return tags;
}

/**
 * Parse one IRC line.
 * @param {string} line a single line without CR/LF
 * @returns {{tags:Record<string,string>, prefix:string|null, nick:string|null,
 *   command:string, params:string[], trailing:string|null, raw:string}|null}
 */
export function parseIrcLine(line) {
  let rest = String(line ?? '');
  if (!rest) return null;
  let tags = {};
  let prefix = null;

  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ');
    if (space < 0) return null;
    tags = parseTagSection(rest.slice(1, space));
    rest = rest.slice(space + 1);
  }
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ');
    if (space < 0) return null;
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }

  const params = [];
  let command = null;
  let trailing = null;
  for (;;) {
    if (!rest) break;
    if (rest.startsWith(' :')) {
      trailing = rest.slice(2);
      break;
    }
    if (rest.startsWith(':')) {
      trailing = rest.slice(1);
      break;
    }
    const space = rest.indexOf(' ');
    const token = space < 0 ? rest : rest.slice(0, space);
    if (command === null) command = token;
    else params.push(token);
    if (space < 0) {
      rest = '';
      break;
    }
    rest = rest.slice(space + 1);
  }
  if (!command) return null;
  return {
    tags,
    prefix,
    nick: prefix ? prefix.split('!')[0] : null,
    command: command.toUpperCase(),
    params,
    trailing,
    raw: String(line)
  };
}

/**
 * Parse a message into individual IRC lines. Twitch may batch several lines in
 * one WebSocket text frame.
 */
export function parseIrcPayload(payload) {
  return String(payload ?? '')
    .split('\r\n')
    .flatMap((line) => line.split('\n'))
    .filter((line) => line.length > 0)
    .map(parseIrcLine)
    .filter(Boolean);
}

/**
 * Parse the `emotes` tag: `25:0-4,6-10/1902:12-14`.
 * Ranges are start/end character indexes in the message body.
 */
export function parseEmotesTag(value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  const emotes = [];
  const seen = new Set();
  for (const group of text.split('/')) {
    const colon = group.indexOf(':');
    if (colon <= 0) continue;
    const id = group.slice(0, colon);
    if (!id || seen.has(id)) continue;
    const ranges = [];
    for (const range of group.slice(colon + 1).split(',')) {
      const match = /^(\d+)-(\d+)$/.exec(range.trim());
      if (!match) continue;
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start) {
        ranges.push({start, end});
      }
    }
    if (ranges.length === 0) continue;
    seen.add(id);
    emotes.push({id, ranges, source: 'twitch.irc.emotes'});
  }
  return emotes;
}

const BADGE_TYPE_MAP = Object.freeze({
  broadcaster: 'owner',
  moderator: 'moderator',
  vip: 'unknown',
  subscriber: 'member',
  founder: 'member',
  premium: 'member',
  staff: 'unknown',
  admin: 'unknown',
  global_mod: 'unknown',
  'sub-gifter': 'unknown',
  bits: 'unknown',
  'bits-leader': 'unknown'
});

/**
 * Parse the `badges` tag into the small canonical badge list:
 * `subscriber/12,moderator/1,broadcaster/1`.
 */
export function parseBadgesTag(value, badgeInfo = '') {
  const months = {};
  for (const pair of String(badgeInfo ?? '').split(',')) {
    const [name, info] = pair.split('/');
    if (name && info) months[name] = info;
  }
  const badges = [];
  const seen = new Set();
  for (const pair of String(value ?? '').split(',')) {
    const [name, version] = pair.split('/');
    if (!name) continue;
    const type = BADGE_TYPE_MAP[name] ?? 'unknown';
    let label = name;
    if (name === 'subscriber' || name === 'founder') {
      label = months[name] ? `Subscriber ${months[name]}` : 'Subscriber';
    } else if (name === 'premium') {
      label = 'Prime';
    } else if (name === 'broadcaster') {
      label = 'Broadcaster';
    } else if (name === 'moderator') {
      label = 'Moderator';
    } else if (name === 'vip') {
      label = 'VIP';
    }
    if (version && !['subscriber', 'founder', 'vip', 'broadcaster', 'moderator', 'premium'].includes(name)) {
      label = `${label} ${version}`;
    }
    const key = `${type}\u0001${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    badges.push({type, label});
    if (badges.length >= 8) break;
  }
  return badges;
}

/** Strip the `/me` ACTION wrapper while keeping the written text. */
export function stripActionWrapper(content) {
  if (typeof content !== 'string') return content;
  if (content.startsWith('\u0001ACTION ') && content.endsWith('\u0001')) {
    return content.slice(8, -1);
  }
  return content;
}

export const __internal = {TAG_ESCAPES, BADGE_TYPE_MAP};

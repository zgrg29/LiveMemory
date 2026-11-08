import {BilibiliLiveAdapter} from '../src/platforms/bilibili/adapter.mjs';
import {decodePackets, normalizeCommand} from '../src/platforms/bilibili/protocol.mjs';

/**
 * Manual real-room probe for emoji / platform-emote fields (read-only).
 *
 *   node scripts/probe-bilibili-emotes.mjs [roomId] [seconds]
 *
 * It never prints full chat bodies. It reports only structural facts:
 * whether `info[1]` contains Unicode emoji, bracketed text like `[笑哭]`,
 * whether `info[0][13]` carries an emote object, and whether `dm_v2` is
 * non-empty. Bracket tokens are printed because they are platform emote names
 * (public labels), not viewer text. Use the result to update
 * docs/PLATFORM_INTEGRATIONS.md and the mapper tests.
 */

const roomArg = Number(process.argv[2] ?? 5050);
const seconds = Number(process.argv[3] ?? 35);
// Off by default: the probe is safe to paste into a report. Set SHOW_TEXT=1 for
// a one-off local inspection of emote text labels (never commit its output).
const SHOW_TEXT = process.env.SHOW_TEXT === '1';

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const BRACKET_RE = /\[[^\]\n]{1,32}\]/g;

function bracketTokens(text) {
  return text.match(BRACKET_RE) ?? [];
}

function emojiCount(text) {
  return (text.match(EMOJI_RE) ?? []).length;
}

function urlShape(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url);
    return {host: parsed.host, pathDepth: parsed.pathname.split('/').filter(Boolean).length, length: url.length};
  } catch {
    return {host: null, pathDepth: null, length: url.length};
  }
}

function metaShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const shape = {};
  for (const key of ['emoticon_unique', 'emoticon_id', 'id', 'package_id', 'width', 'height', 'is_dynamic', 'emoticon_type']) {
    if (value[key] !== undefined) shape[key] = value[key];
  }
  const url = value.url ?? value.emoticon_url ?? value.icon_url;
  if (url) shape.url = urlShape(url);
  return shape;
}

async function main() {
  const stats = {
    danmu: 0,
    withEmoji: 0,
    withBracket: 0,
    withInfo13: 0,
    withDm2: 0,
    mixedTextEmojiBracket: 0,
    onlyBracket: 0
  };
  const metaSamples = [];
  const bracketCounts = new Map();
  const metaKeyCounts = new Map();

  const adapter = new BilibiliLiveAdapter({
    roomId: roomArg,
    logger: {info() {}, warn() {}, debug() {}}
  });

  await adapter.start({onEvent: () => {}});
  const socket = adapter.ws;
  if (!socket) throw new Error('no socket');
  socket.addEventListener('message', async (event) => {
    try {
      const raw = event.data;
      const buffer = typeof raw === 'string'
        ? null
        : (Buffer.isBuffer(raw) ? raw : (raw instanceof ArrayBuffer ? Buffer.from(raw) : (ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : null)));
      if (!buffer) return;
      for (const packet of decodePackets(buffer)) {
        if (packet.op !== 5 || !packet.json) continue;
        const entries = Array.isArray(packet.json) ? packet.json : [packet.json];
        for (const entry of entries) {
          if (normalizeCommand(entry?.cmd) !== 'DANMU_MSG') continue;
          const data = entry.data ?? entry;
          const info = data.info;
          if (!Array.isArray(info)) continue;
          stats.danmu += 1;
          const text = typeof info[1] === 'string' ? info[1] : '';
          const emoji = emojiCount(text);
          const brackets = bracketTokens(text);
          if (emoji > 0) stats.withEmoji += 1;
          if (brackets.length > 0) stats.withBracket += 1;
          if (emoji > 0 && brackets.length > 0) stats.mixedTextEmojiBracket += 1;
          if (text.replace(BRACKET_RE, '').trim() === '') stats.onlyBracket += 1;
          for (const token of brackets) bracketCounts.set(token, (bracketCounts.get(token) ?? 0) + 1);

          const meta13 = info[0]?.[13];
          const meta = metaShape(meta13);
          if (meta) {
            stats.withInfo13 += 1;
            for (const key of Object.keys(meta13 ?? {})) metaKeyCounts.set(key, (metaKeyCounts.get(key) ?? 0) + 1);
          }
          const dm2 = typeof entry.dm_v2 === 'string' ? entry.dm_v2 : (typeof data.dm_v2 === 'string' ? data.dm_v2 : '');
          if (dm2.length > 0) stats.withDm2 += 1;

          if ((meta || brackets.length > 0 || emoji > 0) && metaSamples.length < 12) {
            metaSamples.push({
              textLength: text.length,
              textPreview: SHOW_TEXT ? text : undefined,
              emojiCount: emoji,
              brackets,
              bracketTextOnly: text.replace(BRACKET_RE, '').trim() === '',
              info13: meta,
              info13Keys: meta13 && typeof meta13 === 'object' ? Object.keys(meta13).slice(0, 16) : null,
              dm2Length: dm2.length,
              hasDm2: dm2.length > 0
            });
          }
        }
      }
    } catch {
      /* adapter logs decode failures in production */
    }
  });

  await new Promise((done) => setTimeout(done, seconds * 1000));
  await adapter.stop();

  console.log(`room ${roomArg} — ${seconds}s — DANMU_MSG=${stats.danmu}`);
  console.log(`emoji=${stats.withEmoji} bracket=${stats.withBracket} both=${stats.mixedTextEmojiBracket} bracketOnly=${stats.onlyBracket} info13=${stats.withInfo13} dm2=${stats.withDm2}`);
  console.log('bracket tokens (top 30):');
  console.log([...bracketCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([token, count]) => `${token}=${count}`).join(' ') || '(none)');
  console.log('info[0][13] keys:');
  console.log([...metaKeyCounts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key}=${count}`).join(' ') || '(none)');
  console.log('samples:');
  console.log(JSON.stringify(metaSamples, null, 2));
}

main().catch((error) => {
  console.error('emote probe failed:', error?.code ?? error?.name, error?.message ?? error);
  process.exitCode = 1;
});

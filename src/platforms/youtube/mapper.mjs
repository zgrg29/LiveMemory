import {EVENT_TYPES, SOURCE_QUALITY} from '../../shared/events.mjs';
import {cleanText} from '../../shared/text.mjs';
import {normalizeEmotes} from '../../shared/emoticons.mjs';

/**
 * YouTube Live Chat mapper (reserved, not connected yet).
 *
 * There is no transport, OAuth flow or polling loop in this version. The pure
 * mapper exists so the canonical event model and the AI package already accept
 * YouTube text, Unicode emoji and custom-emote codes when the adapter lands.
 *
 * Field sources:
 * - `snippet.textMessageDetails.messageText` — plain chat text.
 * - `snippet.displayMessage` — display form; used as a fallback.
 * - `snippet.authorChannelId.value` / `authorDetails.channelId` — stable id.
 * - `snippet.publishedAt` — RFC 3339 timestamp.
 *
 * Custom YouTube emotes are commonly represented as `:code:` inside the message
 * text. The official API does not return an image map on the text message, so
 * we keep the code. This behaviour is **not verified against a real broadcast
 * yet** and is deliberately marked `source_quality=unknown`.
 */

export const YOUTUBE_MAPPER_STATUS = 'unverified';

const CODE_PATTERN = /(?<![\p{L}\p{N}_:/]):([A-Za-z0-9_+-]{2,64}):(?![\p{L}\p{N}_/])/gu;

/** Extract `:code:` style custom emote codes without touching the original text. */
export function extractYouTubeEmoteCodes(text) {
  if (typeof text !== 'string' || !text) return [];
  const emotes = [];
  const seen = new Set();
  for (const match of text.matchAll(CODE_PATTERN)) {
    const code = match[0];
    if (seen.has(code)) continue;
    seen.add(code);
    emotes.push({code, name: match[1], source: 'youtube.messageText'});
    if (emotes.length >= 20) break;
  }
  return emotes;
}

function occurredAtFrom(value, fallback) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * @param {object} message a `liveChatMessages.list` item
 * @param {{receivedAt?:number}} options
 * @returns {object|null} canonical draft (without session_id)
 */
export function mapYouTubeChatMessage(message, {receivedAt = Date.now()} = {}) {
  const snippet = message?.snippet;
  if (!snippet || typeof snippet !== 'object') return null;
  if (snippet.type && snippet.type !== 'textMessageEvent') {
    // Super Chat / membership events are a later milestone; do not mislabel
    // them as ordinary chat.
    return null;
  }
  const content = cleanText(
    snippet.textMessageDetails?.messageText ?? snippet.displayMessage,
    4000
  );
  const emotes = normalizeEmotes(extractYouTubeEmoteCodes(content));
  if (!content && !emotes) return null;
  const uid = cleanText(
    snippet.authorChannelId?.value ?? message?.authorDetails?.channelId,
    200
  );
  const name = cleanText(message?.authorDetails?.displayName ?? snippet.displayName, 120);
  const identityComplete = Boolean(uid) && Boolean(name);
  return {
    platform: 'youtube',
    event_type: EVENT_TYPES.CHAT,
    viewer_uid: uid || null,
    display_name: name,
    content,
    emotes,
    occurred_at: occurredAtFrom(snippet.publishedAt, receivedAt),
    is_paid: false,
    gift_type: null,
    source_quality: SOURCE_QUALITY.UNKNOWN,
    identity_complete: identityComplete,
    verified: false
  };
}

import {cleanText} from './text.mjs';

/**
 * Platform emote metadata, kept deliberately small.
 *
 * LiveMemory is a memory/analysis tool, not a pixel-perfect clone of a live
 * chat. The raw message text is always stored unchanged. This module only adds
 * the minimum metadata needed to tell an AI that a piece of text was an emote,
 * and to avoid inventing a meaning when the platform gives us only an id.
 *
 * Shape stored in the database (JSON) and in the analysis package:
 *   {id?, code?, name?, source?}
 * - id:     platform emote identifier (e.g. Bilibili `emoticon_unique`)
 * - code:   textual code (e.g. `:face-blue-smiling:`)
 * - name:   readable label supplied by the platform (never guessed by us)
 * - source: where the metadata came from, for provenance
 *
 * We intentionally do NOT download or cache emote images in this version.
 */

export const MAX_EMOTES_PER_MESSAGE = 20;
const MAX_ID = 200;
const MAX_CODE = 200;
const MAX_NAME = 120;
const MAX_SOURCE = 64;

function firstText(...values) {
  for (const value of values) {
    const cleaned = cleanText(value, Math.max(MAX_ID, MAX_CODE, MAX_NAME));
    if (cleaned) return cleaned;
  }
  return null;
}

/** Normalize one platform emote. Returns null when there is no usable value. */
export function normalizeEmote(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const emote = {
    id: cleanText(input.id, MAX_ID),
    code: cleanText(input.code, MAX_CODE),
    name: cleanText(input.name, MAX_NAME),
    source: cleanText(input.source, MAX_SOURCE)
  };
  if (!emote.id && !emote.code && !emote.name) return null;
  for (const key of Object.keys(emote)) {
    if (emote[key] === null) delete emote[key];
  }
  return emote;
}

export function emoteIdentity(emote) {
  if (!emote) return null;
  if (emote.id) return `id:${emote.id}`;
  if (emote.code) return `code:${emote.code}`;
  if (emote.name) return `name:${emote.name}`;
  return null;
}

/** Normalize and de-duplicate an emote list. Invalid entries are dropped. */
export function normalizeEmotes(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const output = [];
  const seen = new Set();
  for (const entry of value) {
    if (output.length >= MAX_EMOTES_PER_MESSAGE) break;
    const emote = normalizeEmote(entry);
    if (!emote) continue;
    const identity = emoteIdentity(emote);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    output.push(emote);
  }
  return output.length > 0 ? output : null;
}

/** Stable, package-level reference key for the de-duplicated emote dictionary. */
export function emoteKey(platform, emote) {
  const identity = emoteIdentity(emote);
  if (!identity) return null;
  return `${platform || 'unknown'}:${identity}`;
}

/** A readable label for UI/AI fallbacks. This is never a guess at emotion. */
export function emoteLabel(emote) {
  if (!emote) return null;
  return firstText(emote.name, emote.code, emote.id);
}

export function parseEmotesJson(value) {
  if (Array.isArray(value)) return normalizeEmotes(value);
  if (typeof value !== 'string' || !value) return null;
  try {
    return normalizeEmotes(JSON.parse(value));
  } catch {
    return null;
  }
}

export function serializeEmotes(value) {
  const emotes = normalizeEmotes(value);
  return emotes ? JSON.stringify(emotes) : null;
}

const AI_LABELS = {
  'zh-CN': {
    known: (name) => `[平台表情：${name}]`,
    unknown: (id) => `[未知平台表情：emote_id=${id}]`
  },
  ja: {
    known: (name) => `[プラットフォーム絵文字：${name}]`,
    unknown: (id) => `[不明なプラットフォーム絵文字：emote_id=${id}]`
  },
  en: {
    known: (name) => `[platform emote: ${name}]`,
    unknown: (id) => `[unknown platform emote: emote_id=${id}]`
  }
};

export function emoteAiLabels(locale = 'en') {
  return AI_LABELS[locale] ?? AI_LABELS.en;
}

/**
 * Build the AI-readable variant of a message body.
 *
 * Rules:
 * - The original text is never replaced or reordered.
 * - If the platform's text already contains the emote name/code, nothing is
 *   appended (the text is already understandable).
 * - If the text lacks the name, a short annotation is appended.
 * - If only an unknown id exists, it is marked unknown; we never guess an
 *   emotion such as "happy" or "angry".
 * - Returns the original string when no annotation is needed, so callers can
 *   omit a redundant `content_ai` field and keep packages small.
 */
export function buildAiReadableContent({content = null, emotes = null, locale = 'en'} = {}) {
  const original = content === null || content === undefined ? null : String(content);
  const list = normalizeEmotes(emotes);
  if (!list) return original;
  const labels = emoteAiLabels(locale);
  const additions = [];
  const seen = new Set();
  for (const emote of list) {
    const name = firstText(emote.name, emote.code);
    if (name) {
      if (original && original.includes(name)) continue;
      const addition = labels.known(name);
      if (!seen.has(addition)) {
        seen.add(addition);
        additions.push(addition);
      }
      continue;
    }
    const id = firstText(emote.id);
    if (!id) continue;
    if (original && original.includes(id)) continue;
    const addition = labels.unknown(id);
    if (!seen.has(addition)) {
      seen.add(addition);
      additions.push(addition);
    }
  }
  if (additions.length === 0) return original;
  return `${original ?? ''}${additions.join('')}`;
}

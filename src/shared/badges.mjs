import {cleanText} from './text.mjs';

/**
 * Confirmed author badges in a platform-neutral form.
 *
 * These are facts the platform attached to the message at the time it was sent
 * (owner, moderator, verified, member). We keep only a tiny, de-duplicated
 * annotation; labels are never translated or inferred by LiveMemory.
 */
export const BADGE_TYPES = Object.freeze(['owner', 'moderator', 'verified', 'member', 'unknown']);

const TYPE_SET = new Set(BADGE_TYPES);
const MAX_BADGES = 8;
const MAX_LABEL = 80;

export function normalizeBadge(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const type = String(input.type ?? '').trim().toLowerCase();
  const label = cleanText(input.label, MAX_LABEL);
  if (!TYPE_SET.has(type) && !label) return null;
  return {
    type: TYPE_SET.has(type) ? type : 'unknown',
    label
  };
}

export function normalizeBadges(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const output = [];
  const seen = new Set();
  for (const entry of value) {
    if (output.length >= MAX_BADGES) break;
    const badge = normalizeBadge(entry);
    if (!badge) continue;
    const key = `${badge.type}\u0001${badge.label ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(badge);
  }
  return output.length > 0 ? output : null;
}

export function parseBadgesJson(value) {
  if (Array.isArray(value)) return normalizeBadges(value);
  if (typeof value !== 'string' || !value) return null;
  try {
    return normalizeBadges(JSON.parse(value));
  } catch {
    return null;
  }
}

export function serializeBadges(value) {
  const badges = normalizeBadges(value);
  return badges ? JSON.stringify(badges) : null;
}

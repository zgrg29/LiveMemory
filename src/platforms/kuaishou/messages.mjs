import {KUAISHOU_ERRORS, KuaishouError} from './errors.mjs';

/**
 * Anonymous H5 feed parsing.
 *
 * Only `comment` feeds become canonical chat events. The G1 sample contained no
 * gift, like, enter, follow or share feed; those types are counted as ignored,
 * never mapped into an event. LiveMemory therefore does not advertise gift or
 * like support for Kuaishou.
 *
 * The H5 feed has no message id (0% in the G1 sample). Dedupe falls back to a
 * fingerprint of user + platform time + content, which the adapter applies
 * before EventIngest, and which EventIngest applies again across deliveries.
 */

export const KUAISHOU_IDENTITY = Object.freeze({
  MODE: 'session-provisional',
  STABLE_USER_ID: 'unproven',
  /** The H5 sample never carried a platform message id. */
  MESSAGE_ID: false
});

export const KUAISHOU_NON_CHAT_TYPES = Object.freeze([
  'gift',
  'like',
  'enter',
  'follow',
  'share',
  'system'
]);

const MIN_EPOCH_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

/**
 * Viewer ids are deliberately scoped to one local session.
 *
 * G1 observed a numeric `author.userId` on 100% of messages and it was stable
 * within a run, but cross-room/cross-day stability was never proven (229 users
 * across 3 rooms had zero overlap). Using `kuaishou:<userId>` directly would
 * merge identities on an unproven assumption, which the product forbids. The
 * raw platform id is preserved inside the provisional id so a later, evidence-
 * backed decision can be audited; old rows stay separate and are never merged
 * automatically.
 */
export function provisionalViewerUid(sessionId, rawUid) {
  const raw = rawUid === null || rawUid === undefined ? '' : String(rawUid).trim();
  if (!raw || raw === '0') return null;
  const scope = String(sessionId ?? '').trim();
  if (!scope) {
    throw new KuaishouError(KUAISHOU_ERRORS.PROTOCOL, {
      details: {reason: 'session_scope_missing'},
      retryable: false
    });
  }
  return `h5:${raw}@${scope}`;
}

/** Parse the feed's `time` value. Kuaishou H5 normally sends epoch milliseconds. */
export function parseFeedTimestamp(value, {now = Date.now()} = {}) {
  if (value === null || value === undefined || value === '') {
    return {at: null, source: 'missing'};
  }
  let n = Number(value);
  if (!Number.isFinite(n)) return {at: null, source: 'invalid'};
  // Be tolerant of a seconds value without silently changing a valid ms value.
  if (n > 1e9 && n < 1e11) n *= 1000;
  if (!Number.isFinite(n) || n < MIN_EPOCH_MS || n > now + MAX_FUTURE_MS) {
    return {at: null, source: 'out_of_range'};
  }
  return {at: Math.trunc(n), source: 'feed-time'};
}

export function feedTypeOf(feed) {
  return String(feed?.type ?? '').trim().toLowerCase() || 'unknown';
}

export function isCommentFeed(feed) {
  return feedTypeOf(feed) === 'comment';
}

/**
 * Map one real H5 comment into a canonical draft.
 * @returns {{draft: object|null, reason: string|null, rawUid: string|null, timestampSource: string}}
 */
export function mapKuaishouComment(feed, {
  sessionId,
  eid,
  liveStreamId,
  receivedAt = Date.now(),
  now = receivedAt
} = {}) {
  const type = feedTypeOf(feed);
  if (type !== 'comment') {
    return {draft: null, reason: `non_chat:${type}`, rawUid: null, timestampSource: 'none'};
  }
  const content = typeof feed?.content === 'string' ? feed.content : String(feed?.content ?? '');
  if (!content.trim()) {
    return {draft: null, reason: 'empty_content', rawUid: null, timestampSource: 'none'};
  }
  if (!sessionId || !eid) {
    throw new KuaishouError(KUAISHOU_ERRORS.PROTOCOL, {
      details: {reason: 'session_or_room_missing'},
      retryable: false
    });
  }
  const author = feed?.author ?? {};
  const rawUid = author.userId === null || author.userId === undefined
    ? null
    : String(author.userId).trim();
  const viewerUid = provisionalViewerUid(sessionId, rawUid);
  const parsed = parseFeedTimestamp(feed?.time, {now});
  const occurredAt = parsed.at ?? receivedAt;
  const nickname = author.userName === null || author.userName === undefined
    ? ''
    : String(author.userName);

  const draft = {
    platform: 'kuaishou',
    session_id: sessionId,
    event_type: 'chat',
    // No message id exists on this route. Never fabricate one.
    external_id: null,
    viewer_uid: viewerUid,
    display_name: nickname,
    content,
    occurred_at: occurredAt,
    received_at: receivedAt,
    // The H5 route is a research-verified sample, but identity stability is not
    // proven. Keep the canonical quality marker conservative.
    source_quality: 'unknown',
    is_paid: false,
    // Internal counters only; normalizeEvent drops unknown keys.
    _kuaishou: {
      rawUid,
      eid,
      liveStreamId: liveStreamId ?? null,
      feedType: 'comment',
      timestampSource: parsed.source,
      identityMode: KUAISHOU_IDENTITY.MODE,
      messageId: false
    }
  };
  return {draft, reason: null, rawUid, timestampSource: parsed.source};
}

/** Fingerprint used for the adapter's in-run duplicate guard (no message id). */
export function feedFingerprint(feed) {
  const author = feed?.author ?? {};
  const uid = author.userId === null || author.userId === undefined ? '' : String(author.userId);
  return `${uid}\u0001${feed?.time ?? ''}\u0001${feed?.content ?? ''}`;
}

export const __internal = {MIN_EPOCH_MS, MAX_FUTURE_MS};

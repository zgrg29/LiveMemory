/**
 * Broadcaster identity resolution.
 *
 * A broadcaster is a stable channel, never a single broadcast:
 *   - YouTube: channel id (`UC...`). A video id must never become an identity.
 *   - Bilibili: anchor uid when the room payload contains one. If it does not,
 *     the verified room id may be used as a restricted fallback and is marked
 *     as such.
 *   - mock: a single simulated broadcaster so simulated sessions are grouped
 *     without pretending to be a real channel.
 *
 * Sessions that cannot be attributed are kept and marked `unresolved`; they are
 * never guessed into an existing broadcaster.
 */

export const BROADCASTER_IDENTITY = Object.freeze({
  VERIFIED: 'verified',
  ROOM_FALLBACK: 'room_fallback',
  SIMULATED: 'simulated',
  UNRESOLVED: 'unresolved'
});

export const BROADCASTER_IDENTITY_VALUES = Object.freeze([
  BROADCASTER_IDENTITY.VERIFIED,
  BROADCASTER_IDENTITY.ROOM_FALLBACK,
  BROADCASTER_IDENTITY.SIMULATED,
  BROADCASTER_IDENTITY.UNRESOLVED
]);

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_NAME_LENGTH = 200;

function cleanIdentifier(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_IDENTIFIER_LENGTH);
}

function cleanName(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  return text || null;
}

export function isKnownBroadcasterIdentity(value) {
  return BROADCASTER_IDENTITY_VALUES.includes(value);
}

/**
 * @param {{platform?:string, platformRoomId?:string|null, broadcasterUid?:string|number|null, broadcasterName?:string|null}} input
 * @returns {{id:string|null, platform:string, platformUid:string|null, displayName:string|null,
 *   identity:string, unresolvedReason:string|null}}
 */
export function resolveBroadcasterIdentity({
  platform,
  platformRoomId = null,
  broadcasterUid = null,
  broadcasterName = null
} = {}) {
  const platformId = cleanIdentifier(platform) || 'unknown';
  const uid = cleanIdentifier(broadcasterUid);
  const roomId = cleanIdentifier(platformRoomId);
  const displayName = cleanName(broadcasterName);
  const unresolved = (reason) => ({
    id: null,
    platform: platformId,
    platformUid: null,
    displayName,
    identity: BROADCASTER_IDENTITY.UNRESOLVED,
    unresolvedReason: reason
  });

  if (platformId === 'youtube') {
    // Only a channel id is a stable long-term identity. `platformRoomId` here is
    // the video id of one broadcast and is deliberately never used for this.
    if (!uid) return unresolved('youtube_channel_id_missing');
    return {
      id: `youtube:${uid}`,
      platform: 'youtube',
      platformUid: uid,
      displayName,
      identity: BROADCASTER_IDENTITY.VERIFIED,
      unresolvedReason: null
    };
  }

  if (platformId === 'bilibili') {
    if (/^[1-9]\d{0,19}$/.test(uid)) {
      return {
        id: `bilibili:${uid}`,
        platform: 'bilibili',
        platformUid: uid,
        displayName,
        identity: BROADCASTER_IDENTITY.VERIFIED,
        unresolvedReason: null
      };
    }
    // A room id is a restricted fallback: rooms are long-lived, but ownership
    // can change, so this is explicitly marked as lower quality.
    if (/^[1-9]\d{0,19}$/.test(roomId)) {
      return {
        id: `bilibili:room:${roomId}`,
        platform: 'bilibili',
        platformUid: roomId,
        displayName,
        identity: BROADCASTER_IDENTITY.ROOM_FALLBACK,
        unresolvedReason: null
      };
    }
    return unresolved('bilibili_anchor_uid_missing');
  }

  if (platformId === 'mock') {
    return {
      id: 'mock:simulation',
      platform: 'mock',
      platformUid: 'simulation',
      displayName,
      identity: BROADCASTER_IDENTITY.SIMULATED,
      unresolvedReason: null
    };
  }

  if (!uid) return unresolved('broadcaster_uid_missing');
  return {
    id: `${platformId}:${uid}`,
    platform: platformId,
    platformUid: uid,
    displayName,
    identity: BROADCASTER_IDENTITY.VERIFIED,
    unresolvedReason: null
  };
}

/** Human-facing quality ordering: verified beats room fallback. */
export function broadcasterIdentityRank(identity) {
  switch (identity) {
    case BROADCASTER_IDENTITY.VERIFIED: return 3;
    case BROADCASTER_IDENTITY.ROOM_FALLBACK: return 2;
    case BROADCASTER_IDENTITY.SIMULATED: return 1;
    default: return 0;
  }
}

export const __internal = {cleanIdentifier, cleanName};

// Kuaishou G1.5 research prototype — live WebSocket protocol subset.
//
// Protocol facts (field numbers, envelope layout, compression modes) come from
// the web client's own message definitions. Only inbound decoding and the three
// documented outbound frames are implemented here; there is no signing, no
// device fingerprint and no captcha handling.
//
// Envelope: SocketMessage { payloadType = 1, compressionType = 2, payload = 3 }
// Compression: 2 = gzip / raw deflate, 3 = AES-128-CBC (protocol constant).
// Payload types: CS_ENTER_ROOM 200, CS_HEARTBEAT 1, CS_USER_EXIT 202,
//                SC_ENTER_ROOM_ACK 300, SC_FEED_PUSH 310, SC_ERROR 103.

import {createDecipheriv} from 'node:crypto';
import {gunzipSync, inflateRawSync} from 'node:zlib';
import {
  decodeFields, encodeBytes, encodeString, encodeUInt,
  readBytes, readMessage, readMessages, readString, readUInt
} from './protobuf.mjs';

export const PAYLOAD_TYPE = Object.freeze({
  1: 'CS_HEARTBEAT',
  103: 'SC_ERROR',
  200: 'CS_ENTER_ROOM',
  202: 'CS_USER_EXIT',
  300: 'SC_ENTER_ROOM_ACK',
  310: 'SC_FEED_PUSH'
});

const COMPRESSION = Object.freeze({UNKNOWN: 0, NONE: 1, GZIP: 2, AES: 3});

// Transport constant from the official web client bundle (symmetric envelope
// encryption, not an authentication signature). Required only when the server
// marks a frame compressionType=3.
const ENVELOPE_KEY = Buffer.from('PPbzKKL7NB15leYy', 'utf8');
const ENVELOPE_IV = Buffer.from('JRODKJiolJ9xqso0', 'utf8');

export function encodeEnvelope(payloadType, payload) {
  return Buffer.concat([
    encodeUInt(1, payloadType),
    encodeUInt(2, COMPRESSION.NONE),
    encodeBytes(3, payload)
  ]);
}

export function encodeEnterRoom({token, liveStreamId, reconnectCount = 0}) {
  if (!token || !liveStreamId) throw new Error('进房需要 token 与 liveStreamId');
  const body = Buffer.concat([
    encodeString(1, token),
    encodeString(2, liveStreamId),
    ...(reconnectCount > 0 ? [encodeUInt(3, reconnectCount)] : [])
  ]);
  return encodeEnvelope(200, body);
}

export function encodeHeartbeat(timestampMs) {
  return encodeEnvelope(1, encodeUInt(1, timestampMs));
}

export function encodeUserExit(timestampMs) {
  return encodeEnvelope(202, encodeUInt(1, timestampMs));
}

/** Decrypt / decompress an envelope payload. Unknown modes are left as bytes. */
export function unwrapPayload(payload, compressionType) {
  const bytes = Buffer.from(payload);
  if (compressionType === COMPRESSION.AES) {
    const decipher = createDecipheriv('aes-128-cbc', ENVELOPE_KEY, ENVELOPE_IV);
    decipher.setAutoPadding(false);
    let plain = Buffer.concat([decipher.update(bytes), decipher.final()]);
    const pad = plain[plain.length - 1] ?? 0;
    if (pad >= 1 && pad <= 16 && plain.subarray(plain.length - pad).every((b) => b === pad)) {
      plain = plain.subarray(0, plain.length - pad);
    }
    return plain;
  }
  if (compressionType === COMPRESSION.GZIP) {
    try {
      return gunzipSync(bytes);
    } catch {
      return inflateRawSync(bytes);
    }
  }
  return bytes;
}

export function decodeEnvelope(frame) {
  const bytes = Buffer.from(frame);
  const fields = decodeFields(bytes);
  const payloadType = readUInt(fields, 1) ?? 0;
  const compressionType = readUInt(fields, 2) ?? 0;
  const raw = readBytes(fields, 3) ?? Buffer.alloc(0);
  return {
    payloadType,
    type: PAYLOAD_TYPE[payloadType] ?? `UNKNOWN_${payloadType}`,
    compressionType,
    payload: unwrapPayload(raw, compressionType)
  };
}

export function decodeEnterRoomAck(payload) {
  const fields = decodeFields(payload);
  return {heartbeatIntervalMs: readUInt(fields, 3) ?? 20000};
}

export function decodeServerError(payload) {
  const fields = decodeFields(payload);
  return {code: readUInt(fields, 1) ?? null, message: readString(fields, 2), subCode: readUInt(fields, 3) ?? null};
}

function decodeUser(fields) {
  const user = readMessage(fields, 2);
  if (!user) return null;
  const principalId = readString(user, 1);
  if (!principalId) return null;
  return {principalId, nickname: readString(user, 2), headUrl: readString(user, 3)};
}

/**
 * SC_FEED_PUSH → plain feed objects. `id` is the platform's own feed id; it is
 * present in the web protocol definition, so message-level dedupe is possible
 * on this route once a real frame confirms it.
 */
export function decodeFeedPush(payload) {
  const fields = decodeFields(payload);
  const out = {
    watchingCount: readString(fields, 1) || null,
    comments: [],
    likes: [],
    gifts: [],
    shares: [],
    system: []
  };
  for (const f of readMessages(fields, 5)) {
    out.comments.push({
      id: readString(f, 1) || null,
      user: decodeUser(f),
      content: readString(f, 3),
      time: readUInt(f, 9)
    });
  }
  for (const f of readMessages(fields, 8)) {
    out.likes.push({id: readString(f, 1) || null, user: decodeUser(f)});
  }
  for (const f of readMessages(fields, 9)) {
    const giftId = readUInt(f, 4);
    out.gifts.push({
      id: readString(f, 1) || null,
      user: decodeUser(f),
      time: readUInt(f, 3),
      giftId: giftId == null ? null : String(giftId),
      count: readUInt(f, 7) || readUInt(f, 8) || 1
    });
  }
  for (const f of readMessages(fields, 11)) {
    out.system.push({
      id: readString(f, 1) || null,
      user: decodeUser(f),
      time: readUInt(f, 3),
      content: readString(f, 4)
    });
  }
  for (const f of readMessages(fields, 12)) {
    out.shares.push({id: readString(f, 1) || null, user: decodeUser(f), time: readUInt(f, 3)});
  }
  return out;
}

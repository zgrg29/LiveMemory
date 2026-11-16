import {encodeBytesField, encodeVarintField, readFields} from '../../src/platforms/tiktok/protobuf.mjs';

/**
 * Synthetic TikTok Webcast payload builders.
 *
 * Field numbers match the public Webcast schema and were re-checked against
 * real captured payloads (see docs/PLATFORM_RESEARCH_TIKTOK_2026-11.md). The
 * text here is fabricated on purpose: no real viewer nickname or chat body is
 * stored in the repository.
 */

export function messageFields(parts) {
  return Buffer.concat(parts.filter(Boolean));
}

function encodeId(field, value) {
  if (value === null || value === undefined) return null;
  return /^\d+$/.test(String(value))
    ? encodeVarintField(field, BigInt(value))
    : encodeBytesField(field, String(value));
}

export function common({method = 'WebcastChatMessage', msgId = '1001', roomId = '999000', createTime = 1700000000000} = {}) {
  return messageFields([
    encodeBytesField(1, method),
    encodeId(2, msgId),
    encodeVarintField(3, BigInt(roomId)),
    encodeVarintField(4, BigInt(createTime))
  ]);
}

export function user({id = '4242', nickname = 'Alice', uniqueId = 'alice.live', secUid = 'sec-alice'} = {}) {
  return messageFields([
    encodeVarintField(1, BigInt(id)),
    encodeBytesField(3, nickname),
    encodeBytesField(38, uniqueId),
    encodeBytesField(46, secUid)
  ]);
}

export function chatMessage({msgId = '1001', userId = '4242', nickname = 'Alice', content = 'hello', createTime = 1700000000000, roomId = '999000'} = {}) {
  return messageFields([
    encodeBytesField(1, common({method: 'WebcastChatMessage', msgId, roomId, createTime})),
    encodeBytesField(2, user({id: userId, nickname})),
    encodeBytesField(3, content),
    encodeBytesField(14, 'en')
  ]);
}

export function giftMessage({
  msgId = '2001',
  userId = '4242',
  nickname = 'Alice',
  giftId = 56560,
  giftName = 'My First Rose',
  diamonds = 1,
  repeatCount = 1,
  repeatEnd = 1,
  groupId = '777',
  createTime = 1700000000100
} = {}) {
  const details = messageFields([
    encodeBytesField(16, giftName),
    encodeVarintField(12, BigInt(diamonds)),
    encodeVarintField(11, 1n)
  ]);
  return messageFields([
    encodeBytesField(1, common({method: 'WebcastGiftMessage', msgId, createTime})),
    encodeVarintField(2, BigInt(giftId)),
    encodeVarintField(5, BigInt(repeatCount)),
    encodeBytesField(7, user({id: userId, nickname})),
    encodeVarintField(9, BigInt(repeatEnd)),
    encodeVarintField(11, BigInt(groupId)),
    encodeBytesField(15, details)
  ]);
}

export function memberMessage({msgId = '3001', userId = '4242', nickname = 'Alice', createTime = 1700000000200} = {}) {
  return messageFields([
    encodeBytesField(1, common({method: 'WebcastMemberMessage', msgId, createTime})),
    encodeBytesField(2, user({id: userId, nickname})),
    encodeVarintField(3, 12n),
    encodeVarintField(10, 1n)
  ]);
}

export function likeMessage({msgId = '4001', userId = '4242', nickname = 'Alice', count = 5, total = 100} = {}) {
  return messageFields([
    encodeBytesField(1, common({method: 'WebcastLikeMessage', msgId})),
    encodeVarintField(2, BigInt(count)),
    encodeVarintField(3, BigInt(total)),
    encodeBytesField(5, user({id: userId, nickname}))
  ]);
}

export function socialMessage({msgId = '5001', userId = '4242', nickname = 'Alice'} = {}) {
  return messageFields([
    encodeBytesField(1, common({method: 'WebcastSocialMessage', msgId})),
    encodeBytesField(2, user({id: userId, nickname}))
  ]);
}

export function roomUserSeqMessage({msgId = '6001', viewerCount = 321} = {}) {
  return messageFields([
    encodeBytesField(1, common({method: 'WebcastRoomUserSeqMessage', msgId})),
    encodeVarintField(3, BigInt(viewerCount))
  ]);
}

export function controlMessage({msgId = '7001', action = 3} = {}) {
  return messageFields([
    encodeBytesField(1, common({method: 'WebcastControlMessage', msgId})),
    encodeVarintField(2, BigInt(action))
  ]);
}

/** One `ProtoMessageFetchResult.Message` entry (method + payload + int64 id). */
export function envelopeEntry({method, payload, msgId = null}) {
  return messageFields([
    encodeBytesField(1, method),
    encodeBytesField(2, payload),
    encodeId(3, msgId)
  ]);
}

export function fetchResult({
  messages = [],
  cursor = 'cursor-1',
  internalExt = 'fetch_time:1700000000000|seq:1',
  pushServer = 'wss://webcast-ws.example/webcast/im/ws_proxy/',
  routeParams = [['X-Bogus', 'bogus'], ['wrss', 'wrss-token']],
  fetchInterval = 2000,
  needsAck = false
} = {}) {
  const parts = messages.map((entry) => encodeBytesField(1, envelopeEntry(entry)));
  parts.push(encodeBytesField(2, cursor));
  parts.push(encodeVarintField(3, BigInt(fetchInterval)));
  parts.push(encodeVarintField(4, 1700000000123n));
  parts.push(encodeBytesField(5, internalExt));
  parts.push(encodeVarintField(6, 1n));
  for (const [name, value] of routeParams) {
    parts.push(encodeBytesField(7, messageFields([encodeBytesField(1, name), encodeBytesField(2, value)])));
  }
  if (needsAck) parts.push(encodeVarintField(9, 1n));
  parts.push(encodeBytesField(10, pushServer));
  parts.push(encodeVarintField(11, 1n));
  return Buffer.concat(parts);
}

/** Classic WebSocket frame payload (`WebcastResponse`). */
export function webcastResponse({messages = [], cursor = 'cursor-1', internalExt = 'ext', needsAck = false} = {}) {
  const parts = messages.map((entry) => encodeBytesField(1, envelopeEntry(entry)));
  parts.push(encodeBytesField(2, cursor));
  parts.push(encodeVarintField(3, 2000n));
  parts.push(encodeBytesField(5, internalExt));
  if (needsAck) parts.push(encodeVarintField(9, 1n));
  return Buffer.concat(parts);
}

/**
 * Current TikTok web-player socket envelope (`PushFrame`). The event batch
 * lives in field 8, normally gzip-compressed; it is not the frame body itself.
 */
export function pushFrame({payload, payloadType = 'msg', encoding = 'pb', logId = null} = {}) {
  return Buffer.concat([
    ...(logId === null || logId === undefined ? [] : [encodeId(2, logId)]),
    encodeBytesField(6, encoding),
    encodeBytesField(7, payloadType),
    encodeBytesField(8, payload ?? Buffer.alloc(0))
  ]);
}

export function fieldsOf(buffer) {
  return readFields(buffer);
}

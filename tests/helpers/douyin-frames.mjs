import {gzipSync} from 'node:zlib';
import {encodeMessage, MESSAGE_SCHEMAS} from '../../src/platforms/douyin/protobuf.mjs';

/** Test-only builders for Douyin webcast push frames. */

export function chatBody({msgId = '1', userId = '1001', name = 'Alice', content = 'hello', createTime = 1700000000, secUid = 'sec-1', roomId = '42'} = {}) {
  return encodeMessage({
    common: {msgId: BigInt(msgId), roomId: BigInt(roomId), createTime: BigInt(createTime)},
    user: {id: BigInt(userId), nickName: name, secUid},
    content
  }, MESSAGE_SCHEMAS.ChatMessage);
}

export function giftBody({
  msgId = '9',
  userId = '1001',
  name = 'Alice',
  giftId = '500',
  giftName = 'Rose',
  repeatCount = 1,
  groupCount = 1,
  repeatEnd = 1,
  groupId = '77',
  diamondCount = 1,
  createTime = 1700000000
} = {}) {
  return encodeMessage({
    common: {msgId: BigInt(msgId), roomId: 42n, createTime: BigInt(createTime)},
    giftId: BigInt(giftId),
    repeatCount: BigInt(repeatCount),
    groupCount: BigInt(groupCount),
    comboCount: BigInt(repeatCount),
    repeatEnd,
    groupId: BigInt(groupId),
    user: {id: BigInt(userId), nickName: name, secUid: 'sec-1'},
    gift: {id: BigInt(giftId), name: giftName, diamondCount}
  }, MESSAGE_SCHEMAS.GiftMessage);
}

export function memberBody({userId = '1001', name = 'Alice'} = {}) {
  return encodeMessage({
    common: {msgId: 5n, roomId: 42n, createTime: 1700000000n},
    user: {id: BigInt(userId), nickName: name},
    memberCount: 10n
  }, MESSAGE_SCHEMAS.MemberMessage);
}

export function likeBody({userId = '1001', name = 'Alice'} = {}) {
  return encodeMessage({
    common: {msgId: 6n, roomId: 42n},
    count: 3n,
    total: 99n,
    user: {id: BigInt(userId), nickName: name}
  }, MESSAGE_SCHEMAS.LikeMessage);
}

export function responsePayload(messages, {internalExt = '', needAck = false} = {}) {
  return encodeMessage({
    messagesList: messages.map((message) => ({
      method: message.method,
      payload: message.payload,
      msgId: BigInt(message.msgId ?? 0)
    })),
    internalExt,
    needAck
  }, MESSAGE_SCHEMAS.Response);
}

export function pushFrame(messages, {gzip = true, needAck = false, internalExt = '', logId = 7n} = {}) {
  const response = responsePayload(messages, {internalExt, needAck});
  const payload = gzip ? gzipSync(response) : response;
  return encodeMessage({
    logId,
    headersList: gzip ? [{key: 'compress_type', value: 'gzip'}] : [],
    payloadType: 'msg',
    payload
  }, MESSAGE_SCHEMAS.PushFrame);
}

export function chatMessage(id, options = {}) {
  return {method: 'WebcastChatMessage', msgId: id, payload: chatBody({msgId: id, ...options})};
}

export function giftMessage(id, options = {}) {
  return {method: 'WebcastGiftMessage', msgId: id, payload: giftBody({msgId: id, ...options})};
}

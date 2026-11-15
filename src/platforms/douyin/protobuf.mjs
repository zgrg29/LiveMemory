/**
 * Minimal protobuf wire-format codec (no runtime dependency).
 *
 * The Douyin webcast push protocol delivers gzip-compressed protobuf frames.
 * This module implements only what the live adapter needs: reading nested
 * messages by field number and writing the two tiny control frames (heartbeat
 * and ack). Unknown fields are skipped, never guessed.
 *
 * 64-bit integers are kept as BigInt so a 19-digit user id can never lose
 * precision; callers convert them to strings at the identity boundary.
 */

export const WIRE = Object.freeze({VARINT: 0, FIXED64: 1, LENGTH: 2, FIXED32: 5});

const MAX_FIELD_NUMBER = 536870911;

export class ProtobufError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ProtobufError';
    this.code = 'DOUYIN_PROTOCOL';
    this.details = details;
  }
}

function readVarint(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let position = offset;
  for (let index = 0; index < 10; index += 1) {
    if (position >= buffer.length) throw new ProtobufError('truncated varint');
    const byte = buffer[position];
    position += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return {value: result, offset: position};
    shift += 7n;
  }
  throw new ProtobufError('varint too long');
}

function writeVarint(value) {
  let big = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)));
  if (big < 0n) big = BigInt.asUintN(64, big);
  const bytes = [];
  do {
    let byte = Number(big & 0x7fn);
    big >>= 7n;
    if (big > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (big > 0n);
  return Buffer.from(bytes);
}

function skipField(buffer, offset, wireType) {
  switch (wireType) {
    case WIRE.VARINT:
      return readVarint(buffer, offset).offset;
    case WIRE.FIXED64:
      if (offset + 8 > buffer.length) throw new ProtobufError('truncated fixed64');
      return offset + 8;
    case WIRE.FIXED32:
      if (offset + 4 > buffer.length) throw new ProtobufError('truncated fixed32');
      return offset + 4;
    case WIRE.LENGTH: {
      const {value, offset: next} = readVarint(buffer, offset);
      const length = Number(value);
      if (!Number.isSafeInteger(length) || length < 0 || next + length > buffer.length) {
        throw new ProtobufError('truncated length-delimited field');
      }
      return next + length;
    }
    default:
      throw new ProtobufError(`unsupported wire type ${wireType}`);
  }
}

function convertScalar(raw, type) {
  switch (type) {
    case 'uint64':
    case 'int64':
      return raw;
    case 'uint32':
    case 'int32':
      return Number(BigInt.asIntN(32, raw));
    case 'bool':
      return raw !== 0n;
    default:
      return raw;
  }
}

/**
 * @param {Buffer} buffer
 * @param {Record<number, {name:string, type:string, repeated?:boolean}>} fields
 * @returns {object}
 */
export function decodeMessage(buffer, fields) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const out = {};
  let offset = 0;
  while (offset < source.length) {
    const tag = readVarint(source, offset);
    offset = tag.offset;
    const key = Number(tag.value);
    const fieldNumber = key >>> 3;
    const wireType = key & 7;
    if (!Number.isInteger(fieldNumber) || fieldNumber <= 0 || fieldNumber > MAX_FIELD_NUMBER) {
      throw new ProtobufError('invalid field number');
    }
    const spec = fields[fieldNumber];
    if (!spec) {
      offset = skipField(source, offset, wireType);
      continue;
    }
    if (wireType === WIRE.LENGTH) {
      const length = readVarint(source, offset);
      const size = Number(length.value);
      if (!Number.isSafeInteger(size) || size < 0 || length.offset + size > source.length) {
        throw new ProtobufError('truncated message field');
      }
      const raw = source.subarray(length.offset, length.offset + size);
      offset = length.offset + size;
      let value;
      if (spec.type === 'string') value = raw.toString('utf8');
      else if (spec.type === 'bytes') value = Buffer.from(raw);
      else if (spec.type.startsWith('message:')) {
        const nested = spec.type.slice('message:'.length);
        value = decodeMessage(raw, MESSAGE_SCHEMAS[nested] ?? {});
      } else {
        // A scalar encoded as length-delimited (packed repeated) is not used by
        // this protocol; skip it rather than inventing a value.
        continue;
      }
      if (spec.repeated) {
        if (!Array.isArray(out[spec.name])) out[spec.name] = [];
        out[spec.name].push(value);
      } else {
        out[spec.name] = value;
      }
      continue;
    }
    if (wireType !== WIRE.VARINT) {
      offset = skipField(source, offset, wireType);
      continue;
    }
    const {value: raw, offset: next} = readVarint(source, offset);
    offset = next;
    const value = convertScalar(raw, spec.type);
    if (spec.repeated) {
      if (!Array.isArray(out[spec.name])) out[spec.name] = [];
      out[spec.name].push(value);
    } else {
      out[spec.name] = value;
    }
  }
  return out;
}

/**
 * Encode a flat/nested message for control frames. Only the types used by
 * PushFrame/Response are supported; anything else throws instead of silently
 * producing bytes the server would misinterpret.
 */
export function encodeMessage(object, fields) {
  const chunks = [];
  const numbers = Object.keys(fields).map(Number).sort((a, b) => a - b);
  for (const fieldNumber of numbers) {
    const spec = fields[fieldNumber];
    const value = object?.[spec.name];
    if (value === undefined || value === null) continue;
    const values = spec.repeated ? (Array.isArray(value) ? value : [value]) : [value];
    const isLengthDelimited = spec.type === 'string'
      || spec.type === 'bytes'
      || spec.type.startsWith('message:');
    const wireType = isLengthDelimited ? WIRE.LENGTH : WIRE.VARINT;
    for (const item of values) {
      if (item === undefined || item === null) continue;
      chunks.push(writeVarint(BigInt(fieldNumber * 8 + wireType)));
      if (spec.type === 'string') {
        const raw = Buffer.from(String(item), 'utf8');
        chunks.push(writeVarint(BigInt(raw.length)), raw);
      } else if (spec.type === 'bytes') {
        const raw = Buffer.from(item);
        chunks.push(writeVarint(BigInt(raw.length)), raw);
      } else if (spec.type.startsWith('message:')) {
        const nested = spec.type.slice('message:'.length);
        const raw = encodeMessage(item, MESSAGE_SCHEMAS[nested] ?? {});
        chunks.push(writeVarint(BigInt(raw.length)), raw);
      } else if (spec.type === 'bool') {
        chunks.push(writeVarint(item ? 1n : 0n));
      } else {
        chunks.push(writeVarint(item));
      }
    }
  }
  return Buffer.concat(chunks);
}

function longToNumber(value) {
  if (value === undefined || value === null) return null;
  try {
    const big = typeof value === 'bigint' ? value : BigInt(String(value));
    if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
      return {exact: false, value: null, text: big.toString()};
    }
    return {exact: true, value: Number(big), text: big.toString()};
  } catch {
    return null;
  }
}

export function bigintText(value) {
  if (value === undefined || value === null) return '';
  try {
    return (typeof value === 'bigint' ? value : BigInt(String(value))).toString();
  } catch {
    return String(value);
  }
}

export const MESSAGE_SCHEMAS = Object.freeze({
  HeadersList: {
    1: {name: 'key', type: 'string'},
    2: {name: 'value', type: 'string'}
  },
  PushFrame: {
    1: {name: 'seqId', type: 'uint64'},
    2: {name: 'logId', type: 'uint64'},
    3: {name: 'service', type: 'uint64'},
    4: {name: 'method', type: 'uint64'},
    5: {name: 'headersList', type: 'message:HeadersList', repeated: true},
    6: {name: 'payloadEncoding', type: 'string'},
    7: {name: 'payloadType', type: 'string'},
    8: {name: 'payload', type: 'bytes'}
  },
  Response: {
    1: {name: 'messagesList', type: 'message:Message', repeated: true},
    2: {name: 'cursor', type: 'string'},
    3: {name: 'fetchInterval', type: 'uint64'},
    4: {name: 'now', type: 'uint64'},
    5: {name: 'internalExt', type: 'string'},
    6: {name: 'fetchType', type: 'uint32'},
    8: {name: 'heartbeatDuration', type: 'uint64'},
    9: {name: 'needAck', type: 'bool'},
    10: {name: 'pushServer', type: 'string'},
    11: {name: 'liveCursor', type: 'string'}
  },
  Message: {
    1: {name: 'method', type: 'string'},
    2: {name: 'payload', type: 'bytes'},
    3: {name: 'msgId', type: 'int64'},
    4: {name: 'msgType', type: 'int32'}
  },
  Common: {
    1: {name: 'method', type: 'string'},
    2: {name: 'msgId', type: 'uint64'},
    3: {name: 'roomId', type: 'uint64'},
    4: {name: 'createTime', type: 'uint64'}
  },
  User: {
    1: {name: 'id', type: 'uint64'},
    2: {name: 'shortId', type: 'uint64'},
    3: {name: 'nickName', type: 'string'},
    4: {name: 'gender', type: 'uint32'},
    6: {name: 'level', type: 'uint32'},
    21: {name: 'badgeImageList', type: 'message:Image', repeated: true},
    23: {name: 'payGrade', type: 'message:PayGrade'},
    24: {name: 'fansClub', type: 'message:FansClub'},
    46: {name: 'secUid', type: 'string'},
    61: {name: 'newBadgeImageList', type: 'message:Image', repeated: true},
    1029: {name: 'idStr', type: 'string'}
  },
  Image: {
    1: {name: 'urlList', type: 'string', repeated: true},
    2: {name: 'uri', type: 'string'},
    3: {name: 'height', type: 'int64'},
    4: {name: 'width', type: 'int64'},
    6: {name: 'imageType', type: 'int32'},
    8: {name: 'content', type: 'message:ImageContent'},
    9: {name: 'isAnimated', type: 'bool'}
  },
  ImageContent: {
    1: {name: 'name', type: 'string'},
    4: {name: 'alternativeText', type: 'string'}
  },
  PayGrade: {
    6: {name: 'level', type: 'int64'}
  },
  FansClub: {
    1: {name: 'data', type: 'message:FansClubData'}
  },
  FansClubData: {
    1: {name: 'clubName', type: 'string'},
    2: {name: 'level', type: 'int32'},
    3: {name: 'userFansClubStatus', type: 'int32'},
    6: {name: 'anchorId', type: 'int64'}
  },
  Text: {
    1: {name: 'key', type: 'string'},
    2: {name: 'defaultPattern', type: 'string'},
    4: {name: 'pieces', type: 'message:TextPiece', repeated: true}
  },
  TextPiece: {
    1: {name: 'type', type: 'int32'},
    11: {name: 'stringValue', type: 'string'},
    21: {name: 'userValue', type: 'message:TextPieceUser'},
    25: {name: 'imageValue', type: 'message:TextPieceImage'}
  },
  TextPieceUser: {
    1: {name: 'user', type: 'message:User'}
  },
  TextPieceImage: {
    1: {name: 'image', type: 'message:Image'}
  },
  ChatMessage: {
    1: {name: 'common', type: 'message:Common'},
    2: {name: 'user', type: 'message:User'},
    3: {name: 'content', type: 'string'},
    40: {name: 'rtfContent', type: 'message:Text'},
    41: {name: 'rtfContentV2', type: 'message:Text'}
  },
  EmojiChatMessage: {
    1: {name: 'common', type: 'message:Common'},
    2: {name: 'user', type: 'message:User'},
    3: {name: 'emojiId', type: 'int64'},
    4: {name: 'emojiContent', type: 'message:Text'},
    5: {name: 'defaultContent', type: 'string'}
  },
  GiftMessage: {
    1: {name: 'common', type: 'message:Common'},
    2: {name: 'giftId', type: 'int64'},
    4: {name: 'groupCount', type: 'int64'},
    5: {name: 'repeatCount', type: 'int64'},
    6: {name: 'comboCount', type: 'int64'},
    7: {name: 'user', type: 'message:User'},
    8: {name: 'toUser', type: 'message:User'},
    9: {name: 'repeatEnd', type: 'int32'},
    11: {name: 'groupId', type: 'int64'},
    15: {name: 'gift', type: 'message:GiftStruct'},
    16: {name: 'logId', type: 'string'},
    17: {name: 'sendType', type: 'int64'},
    33: {name: 'sendTime', type: 'int64'},
    35: {name: 'traceId', type: 'string'}
  },
  GiftStruct: {
    1: {name: 'image', type: 'message:Image'},
    2: {name: 'describe', type: 'string'},
    5: {name: 'id', type: 'int64'},
    10: {name: 'combo', type: 'bool'},
    11: {name: 'type', type: 'int32'},
    12: {name: 'diamondCount', type: 'int32'},
    16: {name: 'name', type: 'string'},
    21: {name: 'icon', type: 'message:Image'}
  },
  MemberMessage: {
    1: {name: 'common', type: 'message:Common'},
    2: {name: 'user', type: 'message:User'},
    3: {name: 'memberCount', type: 'int64'}
  },
  LikeMessage: {
    1: {name: 'common', type: 'message:Common'},
    2: {name: 'count', type: 'uint64'},
    3: {name: 'total', type: 'uint64'},
    5: {name: 'user', type: 'message:User'}
  },
  SocialMessage: {
    1: {name: 'common', type: 'message:Common'},
    2: {name: 'user', type: 'message:User'},
    4: {name: 'action', type: 'uint64'}
  },
  RoomUserSeqMessage: {
    1: {name: 'common', type: 'message:Common'},
    3: {name: 'total', type: 'int64'},
    6: {name: 'popularity', type: 'int64'},
    7: {name: 'totalUser', type: 'int64'}
  }
});

export const __internal = {readVarint, writeVarint, skipField, longToNumber};

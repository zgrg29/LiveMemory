// Kuaishou G1.5 research prototype — minimal protobuf wire codec.
//
// Only the handful of fields that the documented live WebSocket envelope and
// feed messages use are implemented. This is a hand-written codec over public
// wire-format rules; no protobuf library and no copied source file.
//
// Wire types used here: 0 = varint, 2 = length-delimited (string/bytes/message).

export class ProtobufError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtobufError';
  }
}

export function encodeVarint(value) {
  let n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ProtobufError(`varint 不接受 ${value}`);
  const out = [];
  while (n > 0x7f) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

export function encodeUInt(field, value) {
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(value)]);
}

export function encodeBytes(field, bytes) {
  const body = Buffer.from(bytes);
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(body.length), body]);
}

export function encodeString(field, value) {
  return encodeBytes(field, Buffer.from(String(value ?? ''), 'utf8'));
}

/** Decode one length-delimited message into a Map<number, Array<value>>. */
export function decodeFields(buf) {
  const bytes = Buffer.from(buf);
  const fields = new Map();
  let pos = 0;
  while (pos < bytes.length) {
    const [tag, nextTag] = readVarint(bytes, pos);
    pos = nextTag;
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 0) throw new ProtobufError('字段号为 0');
    let value;
    if (wire === 0) {
      const [v, next] = readVarint(bytes, pos);
      pos = next;
      value = v;
    } else if (wire === 2) {
      const [len, next] = readVarint(bytes, pos);
      pos = next;
      if (len < 0 || pos + len > bytes.length) throw new ProtobufError('长度越界');
      value = bytes.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 5) {
      if (pos + 4 > bytes.length) throw new ProtobufError('fixed32 越界');
      value = bytes.readUInt32LE(pos);
      pos += 4;
    } else if (wire === 1) {
      if (pos + 8 > bytes.length) throw new ProtobufError('fixed64 越界');
      value = bytes.readBigUInt64LE(pos);
      pos += 8;
    } else {
      throw new ProtobufError(`不支持的 wire type ${wire}`);
    }
    const list = fields.get(field);
    if (list) list.push(value);
    else fields.set(field, [value]);
  }
  return fields;
}

export function readString(fields, field) {
  const v = fields.get(field)?.[0];
  return v == null ? '' : Buffer.from(v).toString('utf8');
}

export function readUInt(fields, field) {
  const v = fields.get(field)?.[0];
  if (v == null) return null;
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' ? v : null;
}

export function readMessage(fields, field) {
  const v = fields.get(field)?.[0];
  return v == null ? null : decodeFields(v);
}

export function readMessages(fields, field) {
  return (fields.get(field) ?? []).map((v) => decodeFields(v));
}

export function readBytes(fields, field) {
  return fields.get(field)?.[0] ?? null;
}

function readVarint(bytes, pos) {
  let result = 0;
  let shift = 0;
  while (true) {
    if (pos >= bytes.length) throw new ProtobufError('varint 截断');
    const b = bytes[pos++];
    if (shift > 49) throw new ProtobufError('varint 超出安全整数');
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7;
  }
}

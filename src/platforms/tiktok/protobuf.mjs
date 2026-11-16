import {TIKTOK_ERRORS, TikTokError} from './errors.mjs';

/**
 * Zero-dependency protocol buffer wire codec.
 *
 * The TikTok Webcast endpoint returns protobuf. LiveMemory must not add an npm
 * runtime dependency, so this module implements just the wire format it needs:
 * varints, length-delimited fields, fixed32/fixed64 skipping and nested message
 * access. Unknown fields are preserved as raw bytes and ignored by decoders, so
 * a schema addition on TikTok's side does not break parsing.
 *
 * `uint64` values stay `BigInt` until the mapper formats them as decimal
 * strings; JavaScript numbers would lose precision for ids such as
 * 7708345733036329780.
 */

const MAX_DEPTH = 12;

function protocolError(reason) {
  return new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
    messageKey: 'errors.tiktokProtocol',
    httpStatus: 502,
    details: {reason}
  });
}

export function readVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  let pos = start;
  while (pos < buffer.length) {
    const byte = buffer[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return {value, pos};
    shift += 7n;
    if (shift > 70n) throw protocolError('varint_too_long');
  }
  throw protocolError('varint_truncated');
}

/**
 * Split a protobuf buffer into fields.
 * @returns {Array<{field:number, wire:number, value?:bigint, bytes?:Buffer}>}
 */
export function readFields(buffer, {depth = 0} = {}) {
  if (depth > MAX_DEPTH) throw protocolError('depth');
  if (!Buffer.isBuffer(buffer)) throw protocolError('not_buffer');
  const fields = [];
  let pos = 0;
  while (pos < buffer.length) {
    const key = readVarint(buffer, pos);
    pos = key.pos;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (field <= 0) throw protocolError('field_zero');
    if (wire === 0) {
      const varint = readVarint(buffer, pos);
      pos = varint.pos;
      fields.push({field, wire, value: varint.value});
    } else if (wire === 2) {
      const length = readVarint(buffer, pos);
      pos = length.pos;
      const size = Number(length.value);
      if (!Number.isSafeInteger(size) || size < 0 || pos + size > buffer.length) throw protocolError('length');
      fields.push({field, wire, bytes: buffer.subarray(pos, pos + size)});
      pos += size;
    } else if (wire === 5) {
      if (pos + 4 > buffer.length) throw protocolError('fixed32');
      fields.push({field, wire, bytes: buffer.subarray(pos, pos + 4)});
      pos += 4;
    } else if (wire === 1) {
      if (pos + 8 > buffer.length) throw protocolError('fixed64');
      fields.push({field, wire, bytes: buffer.subarray(pos, pos + 8)});
      pos += 8;
    } else if (wire === 3 || wire === 4) {
      // Group wire types are deprecated and never used by Webcast. Skipping
      // them would require matching end-group markers; fail loudly instead.
      throw protocolError('group');
    } else {
      throw protocolError('wire_type');
    }
  }
  return fields;
}

export function field(fields, number, wire = null) {
  for (const entry of fields) {
    if (entry.field === number && (wire === null || entry.wire === wire)) return entry;
  }
  return null;
}

export function allFields(fields, number, wire = null) {
  return fields.filter((entry) => entry.field === number && (wire === null || entry.wire === wire));
}

export function asString(entry) {
  if (!entry || entry.wire !== 2) return null;
  return entry.bytes.toString('utf8');
}

export function asNumber(entry) {
  if (!entry) return null;
  if (entry.wire === 0) return Number(entry.value);
  return null;
}

export function asDecimal(entry) {
  if (!entry || entry.wire !== 0) return null;
  return entry.value.toString();
}

/** Decode a nested length-delimited field. Returns [] when absent. */
export function nested(fields, number) {
  const entry = field(fields, number, 2);
  if (!entry) return [];
  return readFields(entry.bytes);
}

function utf8LooksLikeText(bytes) {
  if (!bytes || bytes.length === 0) return false;
  if (bytes.includes(0)) return false;
  let printable = 0;
  for (const byte of bytes) {
    if (byte >= 0x20 && byte < 0x7f) printable += 1;
  }
  // UTF-8 multi-byte sequences make a strict ratio unreliable; this is only a
  // diagnostics helper, never a parsing decision.
  return printable / bytes.length >= 0.6;
}

/* -------------------------------------------------------------- encoding */

export function writeVarint(value) {
  let remaining = BigInt(value);
  if (remaining < 0n) throw protocolError('negative_varint');
  const out = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0n);
  return Buffer.from(out);
}

export function encodeVarintField(number, value) {
  return Buffer.concat([writeVarint((BigInt(number) << 3n) | 0n), writeVarint(value)]);
}

export function encodeBytesField(number, bytes) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  return Buffer.concat([writeVarint((BigInt(number) << 3n) | 2n), writeVarint(BigInt(payload.length)), payload]);
}

export const __internal = {utf8LooksLikeText, protocolError, MAX_DEPTH};

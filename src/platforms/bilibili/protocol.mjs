import {inflateSync, brotliDecompressSync} from 'node:zlib';

/**
 * Bilibili live WebSocket packet format.
 *
 * Header (16 bytes, big endian):
 *   0..4   total packet length (header + body)
 *   4..6   header length (16)
 *   6..8   protocol version (0/1 plain JSON, 2 zlib, 3 brotli)
 *   8..12  operation (2 heartbeat, 3 popularity, 5 message, 7 auth, 8 auth reply)
 *   12..16 sequence
 *
 * A single WebSocket frame may contain many concatenated packets, and a
 * compressed packet contains more packets, so decoding is recursive with hard
 * limits on input size and depth.
 */

export const OP = Object.freeze({
  HEARTBEAT: 2,
  POPULARITY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8
});

export const PROTOCOL_VERSION = Object.freeze({
  PLAIN: 0,
  HEARTBEAT_REPLY: 1,
  ZLIB: 2,
  BROTLI: 3
});

const HEADER_SIZE = 16;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 3;

export function encodePacket(operation, data = '', {version = PROTOCOL_VERSION.HEARTBEAT_REPLY, sequence = 1} = {}) {
  const body = Buffer.isBuffer(data)
    ? data
    : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32BE(body.length + HEADER_SIZE, 0);
  header.writeUInt16BE(HEADER_SIZE, 4);
  header.writeUInt16BE(version, 6);
  header.writeUInt32BE(operation, 8);
  header.writeUInt32BE(sequence, 12);
  return Buffer.concat([header, body]);
}

export function encodeAuth({roomId, uid = 0, token, buvid = null, protover = 3}) {
  return encodePacket(OP.AUTH, {
    uid: Number(uid) || 0,
    roomid: Number(roomId),
    protover,
    platform: 'web',
    type: 2,
    key: String(token ?? ''),
    ...(buvid ? {buvid} : {})
  });
}

/** Heartbeat body: the platform accepts an empty JSON object. */
export function encodeHeartbeat() {
  return encodePacket(OP.HEARTBEAT, '{}');
}

/**
 * @returns {Array<{op:number, version:number, body:Buffer, json:any, popularity:number|null}>}
 */
export function decodePackets(input, {depth = 0} = {}) {
  if (!Buffer.isBuffer(input)) throw new Error('decodePackets expects a Buffer');
  if (depth > MAX_DEPTH) throw new Error('too many nested compressed packets');
  if (input.length > MAX_INPUT_BYTES) throw new Error('packet frame is too large');

  const results = [];
  let offset = 0;
  while (offset < input.length) {
    if (input.length - offset < HEADER_SIZE) throw new Error('truncated packet header');
    const length = input.readUInt32BE(offset);
    const headerSize = input.readUInt16BE(offset + 4);
    const version = input.readUInt16BE(offset + 6);
    const operation = input.readUInt32BE(offset + 8);
    if (headerSize < HEADER_SIZE || length < headerSize || offset + length > input.length) {
      throw new Error('invalid packet length');
    }
    const body = input.subarray(offset + headerSize, offset + length);
    offset += length;

    if (version === PROTOCOL_VERSION.ZLIB || version === PROTOCOL_VERSION.BROTLI) {
      const inflated = version === PROTOCOL_VERSION.ZLIB
        ? inflateSync(body, {maxOutputLength: MAX_DECOMPRESSED_BYTES})
        : brotliDecompressSync(body, {maxOutputLength: MAX_DECOMPRESSED_BYTES});
      results.push(...decodePackets(inflated, {depth: depth + 1}));
      continue;
    }

    if (operation === OP.MESSAGE || operation === OP.AUTH_REPLY || operation === OP.AUTH) {
      const text = body.toString('utf8');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('message body is not JSON');
      }
      results.push({op: operation, version, body, json, popularity: null});
      continue;
    }

    if (operation === OP.POPULARITY) {
      results.push({
        op: operation,
        version,
        body,
        json: null,
        popularity: body.length >= 4 ? body.readUInt32BE(0) : null
      });
      continue;
    }

    // Heartbeats/replies without a JSON body: kept for diagnostics.
    results.push({op: operation, version, body, json: null, popularity: null});
  }
  return results;
}

export function normalizeCommand(cmd) {
  return String(cmd ?? '').split(':')[0];
}

export const __internal = {HEADER_SIZE, MAX_INPUT_BYTES, MAX_DECOMPRESSED_BYTES, MAX_DEPTH};

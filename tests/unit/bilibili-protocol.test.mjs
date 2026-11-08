import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync, brotliCompressSync} from 'node:zlib';
import {
  decodePackets,
  encodeAuth,
  encodeHeartbeat,
  encodePacket,
  normalizeCommand,
  OP,
  PROTOCOL_VERSION
} from '../../src/platforms/bilibili/protocol.mjs';

function readHeader(packet) {
  return {
    length: packet.readUInt32BE(0),
    header: packet.readUInt16BE(4),
    version: packet.readUInt16BE(6),
    op: packet.readUInt32BE(8),
    sequence: packet.readUInt32BE(12)
  };
}

test('a plain packet round-trips through the header layout', () => {
  const body = JSON.stringify({cmd: 'DANMU_MSG', data: {info: []}});
  const packet = encodePacket(OP.MESSAGE, body);
  const header = readHeader(packet);
  assert.equal(header.length, packet.length);
  assert.equal(header.header, 16);
  assert.equal(header.version, 1);
  assert.equal(header.op, OP.MESSAGE);
  assert.equal(header.sequence, 1);
  const decoded = decodePackets(packet);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].op, OP.MESSAGE);
  assert.equal(decoded[0].json.cmd, 'DANMU_MSG');
});

test('an auth packet carries the room, token and protocol version', () => {
  const packet = encodeAuth({roomId: 5050, uid: 0, token: 'tok', buvid: 'buvid'});
  const decoded = decodePackets(packet);
  assert.equal(decoded[0].op, OP.AUTH);
  assert.equal(decoded[0].json.roomid, 5050);
  assert.equal(decoded[0].json.protover, 3);
  assert.equal(decoded[0].json.key, 'tok');
  assert.equal(decoded[0].json.buvid, 'buvid');
  assert.equal(decoded[0].json.uid, 0);
});

test('the heartbeat body is an empty JSON object', () => {
  const packet = encodeHeartbeat();
  const header = readHeader(packet);
  assert.equal(header.op, OP.HEARTBEAT);
  assert.equal(packet.subarray(16).toString('utf8'), '{}');
});

test('multiple concatenated packets in one frame are all decoded', () => {
  const first = encodePacket(OP.MESSAGE, JSON.stringify({cmd: 'DANMU_MSG'}));
  const second = encodePacket(OP.MESSAGE, JSON.stringify({cmd: 'SEND_GIFT'}));
  const decoded = decodePackets(Buffer.concat([first, second]));
  assert.deepEqual(decoded.map((entry) => entry.json.cmd), ['DANMU_MSG', 'SEND_GIFT']);
});

test('zlib (version 2) and brotli (version 3) bodies are inflated recursively', () => {
  const inner = encodePacket(OP.MESSAGE, JSON.stringify({cmd: 'DANMU_MSG'}));
  const zlibPacket = Buffer.concat([
    (() => {
      const header = Buffer.alloc(16);
      const body = deflateSync(inner);
      header.writeUInt32BE(body.length + 16, 0);
      header.writeUInt16BE(16, 4);
      header.writeUInt16BE(PROTOCOL_VERSION.ZLIB, 6);
      header.writeUInt32BE(OP.MESSAGE, 8);
      header.writeUInt32BE(1, 12);
      return Buffer.concat([header, body]);
    })()
  ]);
  assert.equal(decodePackets(zlibPacket)[0].json.cmd, 'DANMU_MSG');

  const brotliBody = brotliCompressSync(inner);
  const brotliHeader = Buffer.alloc(16);
  brotliHeader.writeUInt32BE(brotliBody.length + 16, 0);
  brotliHeader.writeUInt16BE(16, 4);
  brotliHeader.writeUInt16BE(PROTOCOL_VERSION.BROTLI, 6);
  brotliHeader.writeUInt32BE(OP.MESSAGE, 8);
  brotliHeader.writeUInt32BE(1, 12);
  const decoded = decodePackets(Buffer.concat([brotliHeader, brotliBody]));
  assert.equal(decoded[0].json.cmd, 'DANMU_MSG');
});

test('popularity packets expose the viewer count', () => {
  const body = Buffer.alloc(4);
  body.writeUInt32BE(123456, 0);
  const header = Buffer.alloc(16);
  header.writeUInt32BE(20, 0);
  header.writeUInt16BE(16, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt32BE(OP.POPULARITY, 8);
  header.writeUInt32BE(1, 12);
  const decoded = decodePackets(Buffer.concat([header, body]));
  assert.equal(decoded[0].op, OP.POPULARITY);
  assert.equal(decoded[0].popularity, 123456);
});

test('malformed frames are rejected instead of producing garbage', () => {
  assert.throws(() => decodePackets(Buffer.alloc(8)), /truncated/);
  const bad = Buffer.alloc(16);
  bad.writeUInt32BE(1000, 0); // longer than the buffer
  bad.writeUInt16BE(16, 4);
  assert.throws(() => decodePackets(bad), /invalid packet length/);
});

test('command variants are normalized', () => {
  assert.equal(normalizeCommand('DANMU_MSG:4:0:2:2:2:0'), 'DANMU_MSG');
  assert.equal(normalizeCommand(undefined), '');
});

/**
 * Minimal ZIP writer (STORE method, no compression).
 *
 * LiveMemory needs a single portable file for AI analysis packages today and
 * for backups in M5. Implementing a small, dependency-free writer keeps the
 * packaged Windows executable free of native modules, and lets us produce
 * deterministic archives (fixed timestamps) that are easy to checksum.
 *
 * Only the subset needed by the app is implemented: regular files, UTF-8
 * names, no directories, no encryption (backup encryption lands in M5 and will
 * be applied to the archive payload with a vetted AEAD scheme).
 */
import {createHash} from 'node:crypto';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/** MS-DOS date/time pair for the fixed 1980-01-01 00:00 timestamp. */
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = (0 << 9) | (1 << 5) | 1;

function assertSafeEntryName(name) {
  const text = String(name ?? '');
  if (!text || text.length > 255) throw new Error('zip: invalid entry name length');
  const normalized = text.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.includes('\u0000')) {
    throw new Error('zip: invalid entry name');
  }
  if (normalized.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('zip: path traversal in entry name');
  }
  return normalized;
}

/**
 * Build a ZIP archive.
 * @param {Array<{name: string, data: string|Buffer|Uint8Array}>} entries
 * @param {{date?: Date}} [options]
 * @returns {Buffer}
 */
export function createZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('zip: no entries');
  if (entries.length > 10000) throw new Error('zip: too many entries');

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = assertSafeEntryName(entry.name);
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? '', 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // UTF-8 names
    central.writeUInt16LE(0, 10); // store
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attr
    central.writeUInt32LE(0, 38); // external attr
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
    if (offset > 0xffffffff) throw new Error('zip: archive too large');
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

/**
 * Read the archive index (central directory) without extracting. Used by the
 * backup/AI import path to validate an archive before touching user data.
 */
export function readZipIndex(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('zip: not an archive');
  let endOffset = -1;
  const lowerBound = Math.max(0, buffer.length - 22 - 0xffff);
  for (let index = buffer.length - 22; index >= lowerBound; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      endOffset = index;
      break;
    }
  }
  if (endOffset < 0) throw new Error('zip: end of central directory not found');
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize > buffer.length) throw new Error('zip: corrupt central directory');

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('zip: corrupt central entry');
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    entries.push({name, method, compressedSize, uncompressedSize, localOffset});
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Extract a single stored (uncompressed) entry. */
export function readZipEntry(buffer, name) {
  const entries = readZipIndex(buffer);
  const entry = entries.find((item) => item.name === name);
  if (!entry) throw new Error(`zip: entry not found: ${name}`);
  if (entry.method !== 0) throw new Error('zip: only stored entries are supported');
  const local = entry.localOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) {
    throw new Error('zip: corrupt local header');
  }
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new Error('zip: truncated entry');
  return data;
}

export function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

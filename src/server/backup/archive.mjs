import {
  closeSync,
  fsyncSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import {createHash} from 'node:crypto';
import {createCrc32} from '../../shared/zip.mjs';
import {AppError} from '../../shared/errors.mjs';
import {BACKUP_LIMITS} from './constants.mjs';

/**
 * Hardened, file-backed ZIP reader for user-supplied backup archives.
 *
 * The archive is untrusted input. This module never trusts a declared length
 * without checking it against the real file, only accepts STORE entries, and
 * validates entry names before anything is extracted:
 *
 * - absolute paths, drive letters, UNC paths, backslashes and `..` segments are
 *   rejected (ZIP Slip);
 * - symlink entries are rejected (external attribute check);
 * - encrypted entries, data descriptors and ZIP64 archives are rejected;
 * - duplicate names, empty/directory entries and control characters are rejected;
 * - entry count, per-entry size, total size and central-directory size are capped;
 * - every entry's CRC-32 is verified while it is streamed, so a truncated or
 *   modified archive fails before a single byte is committed.
 *
 * `openArchive` reads only the central directory; file data is streamed to the
 * destination so a large database is never loaded into memory.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT = 0xffff;
const CHUNK_SIZE = 1024 * 1024;

function invalid(detail, messageKey = 'errors.backupInvalidArchive') {
  return new AppError('BACKUP_INVALID_ARCHIVE', {
    messageKey,
    details: detail ? {reason: detail} : null,
    httpStatus: 400
  });
}

function readFully(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, buffer, offset, length - offset, position + offset);
    if (read <= 0) throw invalid('truncated');
    offset += read;
  }
  return buffer;
}

export function validateEntryName(name, {limits = BACKUP_LIMITS} = {}) {
  if (typeof name !== 'string' || name.length === 0) throw invalid('empty-name');
  if (name.length > limits.maxPathLength) throw invalid('name-too-long');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw invalid('control-character');
  if (name.includes('\\')) throw invalid('backslash');
  if (name.startsWith('/')) throw invalid('absolute-path');
  if (/^[A-Za-z]:/.test(name)) throw invalid('drive-letter');
  if (name.startsWith('//')) throw invalid('unc-path');
  if (name.includes(':')) throw invalid('colon');
  if (name.endsWith('/')) throw invalid('directory-entry');
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw invalid('path-traversal');
  }
  return name;
}

function isSymlinkEntry(externalAttributes) {
  // High 16 bits are the Unix mode when created on Unix. 0xA000 is S_IFLNK.
  const mode = (Number(externalAttributes) >>> 16) & 0xffff;
  return (mode & 0xf000) === 0xa000;
}

function checkLocalHeader(fd, entry, {cdOffset, fileSize}) {
  if (entry.localOffset + LOCAL_HEADER_SIZE > fileSize) throw invalid('local-header-outside-file');
  if (entry.localOffset + LOCAL_HEADER_SIZE > cdOffset) throw invalid('local-header-overlaps-central');
  const header = readFully(fd, LOCAL_HEADER_SIZE, entry.localOffset);
  if (header.readUInt32LE(0) !== SIG_LOCAL) throw invalid('local-header-signature');
  const flags = header.readUInt16LE(6);
  const method = header.readUInt16LE(8);
  const crc = header.readUInt32LE(14);
  const compressedSize = header.readUInt32LE(18);
  const uncompressedSize = header.readUInt32LE(22);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  if (flags !== entry.flags || method !== entry.method) throw invalid('local-header-mismatch');
  if (crc !== entry.crc || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize) {
    throw invalid('local-size-mismatch');
  }
  const nameStart = entry.localOffset + LOCAL_HEADER_SIZE;
  if (nameStart + nameLength + extraLength > fileSize) throw invalid('local-header-truncated');
  const localName = readFully(fd, nameLength, nameStart).toString('utf8');
  if (localName !== entry.name) throw invalid('local-name-mismatch');
  const dataOffset = nameStart + nameLength + extraLength;
  if (dataOffset + entry.compressedSize > fileSize) throw invalid('data-outside-file');
  if (dataOffset + entry.compressedSize > cdOffset) throw invalid('data-overlaps-central');
  return dataOffset;
}

/**
 * Parse and validate an archive without extracting anything.
 * @param {string} file
 * @param {{limits?: object}} [options]
 */
export function openArchive(file, {limits = BACKUP_LIMITS} = {}) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    throw new AppError('BACKUP_FILE_NOT_FOUND', {
      messageKey: 'errors.backupFileNotFound',
      httpStatus: 404
    });
  }
  if (!stat.isFile()) {
    throw new AppError('BACKUP_FILE_NOT_FOUND', {
      messageKey: 'errors.backupFileNotFound',
      httpStatus: 404
    });
  }
  if (stat.size > limits.maxArchiveBytes) {
    throw new AppError('BACKUP_TOO_LARGE', {
      messageKey: 'errors.backupTooLarge',
      details: {bytes: stat.size, limit: limits.maxArchiveBytes},
      httpStatus: 413
    });
  }
  if (stat.size < EOCD_SIZE) throw invalid('too-small');

  const fd = openSync(file, 'r');
  try {
    const tailLength = Math.min(stat.size, EOCD_SIZE + MAX_COMMENT);
    const tail = readFully(fd, tailLength, stat.size - tailLength);
    let eocdIndex = -1;
    for (let index = tailLength - EOCD_SIZE; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) !== SIG_EOCD) continue;
      const commentLength = tail.readUInt16LE(index + 20);
      if (index + EOCD_SIZE + commentLength !== tailLength) continue;
      eocdIndex = index;
      break;
    }
    if (eocdIndex < 0) throw invalid('eocd-not-found');

    const diskNumber = tail.readUInt16LE(eocdIndex + 4);
    const centralDisk = tail.readUInt16LE(eocdIndex + 6);
    const entriesOnDisk = tail.readUInt16LE(eocdIndex + 8);
    const entriesTotal = tail.readUInt16LE(eocdIndex + 10);
    const centralSize = tail.readUInt32LE(eocdIndex + 12);
    const centralOffset = tail.readUInt32LE(eocdIndex + 16);
    const eocdOffset = stat.size - tailLength + eocdIndex;

    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entriesTotal) {
      throw invalid('multi-disk');
    }
    if (entriesTotal === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw invalid('zip64-unsupported');
    }
    if (entriesTotal === 0) throw invalid('empty-archive');
    if (entriesTotal > limits.maxEntries) {
      throw new AppError('BACKUP_TOO_MANY_ENTRIES', {
        messageKey: 'errors.backupTooManyEntries',
        details: {entries: entriesTotal, limit: limits.maxEntries},
        httpStatus: 400
      });
    }
    if (centralSize > limits.maxCentralDirectoryBytes) throw invalid('central-directory-too-large');
    if (centralOffset + centralSize !== eocdOffset) throw invalid('central-directory-bounds');
    if (centralOffset + centralSize > stat.size) throw invalid('central-directory-outside-file');

    const central = readFully(fd, centralSize, centralOffset);
    const entries = [];
    const names = new Set();
    let cursor = 0;
    let totalUncompressed = 0;
    for (let index = 0; index < entriesTotal; index += 1) {
      if (cursor + CENTRAL_HEADER_SIZE > central.length) throw invalid('central-entry-truncated');
      if (central.readUInt32LE(cursor) !== SIG_CENTRAL) throw invalid('central-signature');
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const crc = central.readUInt32LE(cursor + 16);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const diskStart = central.readUInt16LE(cursor + 34);
      const externalAttributes = central.readUInt32LE(cursor + 38);
      const localOffset = central.readUInt32LE(cursor + 42);
      if (diskStart !== 0) throw invalid('multi-disk');
      if (flags & 0x0001) throw invalid('encrypted-entry');
      if (flags & 0x0008) throw invalid('data-descriptor-unsupported');
      if (flags & 0x0040) throw invalid('strong-encryption');
      if (method !== 0) throw invalid('compression-unsupported');
      if (compressedSize !== uncompressedSize) throw invalid('size-mismatch');
      if (compressedSize > limits.maxEntryBytes) throw invalid('entry-too-large');
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > limits.maxTotalUncompressedBytes) {
        throw new AppError('BACKUP_TOO_LARGE', {
          messageKey: 'errors.backupTooLarge',
          details: {bytes: totalUncompressed, limit: limits.maxTotalUncompressedBytes},
          httpStatus: 413
        });
      }
      if (isSymlinkEntry(externalAttributes)) throw invalid('symlink-entry');
      if (cursor + CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength > central.length) {
        throw invalid('central-entry-truncated');
      }
      const nameBuffer = central.subarray(
        cursor + CENTRAL_HEADER_SIZE,
        cursor + CENTRAL_HEADER_SIZE + nameLength
      );
      const name = validateEntryName(nameBuffer.toString('utf8'), {limits});
      if (names.has(name)) throw invalid('duplicate-entry');
      names.add(name);
      const entry = {
        name,
        flags,
        method,
        crc,
        compressedSize,
        uncompressedSize,
        localOffset,
        dataOffset: 0
      };
      entry.dataOffset = checkLocalHeader(fd, entry, {cdOffset: centralOffset, fileSize: stat.size});
      entries.push(entry);
      cursor += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
    }
    if (cursor !== central.length) throw invalid('central-size-mismatch');

    return {
      file,
      fd,
      size: stat.size,
      entries,
      has(name) {
        return names.has(name);
      },
      entry(name) {
        return entries.find((item) => item.name === name) ?? null;
      },
      close() {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    };
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function readEntryChunks(archive, entry, onChunk) {
  const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, entry.compressedSize || 1));
  const crc = createCrc32();
  let position = 0;
  while (position < entry.compressedSize) {
    const length = Math.min(buffer.length, entry.compressedSize - position);
    const read = readSync(archive.fd ?? -1, buffer, 0, length, entry.dataOffset + position);
    if (read <= 0) throw invalid('entry-truncated');
    const chunk = buffer.subarray(0, read);
    crc.update(chunk);
    onChunk(chunk);
    position += read;
  }
  if (crc.digest() !== entry.crc) {
    throw new AppError('BACKUP_CHECKSUM_MISMATCH', {
      messageKey: 'errors.backupChecksumMismatch',
      details: {entry: entry.name},
      httpStatus: 400
    });
  }
}

/**
 * Stream one entry to a new file. The destination is removed on any failure.
 * @returns {{bytes: number, sha256: string}}
 */
export function extractEntryToFile(archive, entry, destination, {signal = null, onProgress = null} = {}) {
  if (!archive || !entry) throw invalid('missing-entry');
  const hash = createHash('sha256');
  const fd = openSync(destination, 'wx');
  let bytes = 0;
  try {
    // `readEntryChunks` needs the archive fd; expose it on the archive object.
    readEntryChunks(archive, entry, (chunk) => {
      if (signal?.aborted) {
        throw new AppError('BACKUP_CANCELLED', {
          messageKey: 'errors.backupCancelled',
          httpStatus: 409
        });
      }
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        offset += writeSync(fd, chunk, offset, chunk.length - offset);
      }
      bytes += chunk.length;
      onProgress?.({done: bytes, total: entry.uncompressedSize});
    });
    fsyncSync(fd);
    return {bytes, sha256: hash.digest('hex')};
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(destination);
    } catch {
      /* best effort */
    }
    throw error;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed on the error path */
    }
  }
}

/** Read a small entry (manifest/settings) and verify its CRC. */
export function readEntryBuffer(archive, entry, {maxBytes = BACKUP_LIMITS.maxManifestBytes} = {}) {
  if (!archive || !entry) throw invalid('missing-entry');
  if (entry.uncompressedSize > maxBytes) {
    throw new AppError('BACKUP_TOO_LARGE', {
      messageKey: 'errors.backupTooLarge',
      details: {entry: entry.name, bytes: entry.uncompressedSize, limit: maxBytes},
      httpStatus: 413
    });
  }
  const chunks = [];
  readEntryChunks(archive, entry, (chunk) => chunks.push(Buffer.from(chunk)));
  return Buffer.concat(chunks);
}

/** SHA-256 of a whole file, streamed. */
export function sha256File(file, {signal = null, onProgress = null} = {}) {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const buffer = Buffer.alloc(CHUNK_SIZE);
    let position = 0;
    while (position < size) {
      if (signal?.aborted) {
        throw new AppError('BACKUP_CANCELLED', {messageKey: 'errors.backupCancelled', httpStatus: 409});
      }
      const length = Math.min(buffer.length, size - position);
      const read = readSync(fd, buffer, 0, length, position);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
      onProgress?.({done: position, total: size});
    }
    return {sha256: hash.digest('hex'), bytes: position};
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

export const __internal = {SIG_LOCAL, SIG_CENTRAL, SIG_EOCD, checkLocalHeader, isSymlinkEntry};

import {closeSync, fsyncSync, openSync, readSync, writeSync} from 'node:fs';
import {createCrc32} from '../../shared/zip.mjs';
import {AppError} from '../../shared/errors.mjs';
import {validateEntryName} from './archive.mjs';

/**
 * Streaming ZIP writer (STORE only) for portable backups.
 *
 * Unlike the in-memory writer used for AI packages, this one never loads the
 * database into memory. It also re-computes the CRC of each source file while
 * writing, so a file that changed between the checksum pass and the write is
 * reported instead of being committed.
 */

const CHUNK_SIZE = 1024 * 1024;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function cancellationError() {
  return new AppError('BACKUP_CANCELLED', {messageKey: 'errors.backupCancelled', httpStatus: 409});
}

/**
 * @param {{file: string, entries: Array<{name: string, size: number, crc: number,
 *   sha256?: string, data?: Buffer, filePath?: string}>, signal?: AbortSignal,
 *   onProgress?: Function, timestamp?: Date}} options
 */
export function writeBackupArchive({file, entries, signal = null, onProgress = null, timestamp = new Date()}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('backup: no entries');
  const totalBytes = entries.reduce((sum, entry) => sum + Number(entry.size ?? 0), 0);
  let writtenBytes = 0;
  const centralParts = [];
  let offset = 0;
  const dosTime = ((timestamp.getHours() << 11) | (timestamp.getMinutes() << 5) | Math.floor(timestamp.getSeconds() / 2)) & 0xffff;
  const dosDate = (((timestamp.getFullYear() - 1980) << 9) | ((timestamp.getMonth() + 1) << 5) | timestamp.getDate()) & 0xffff;

  const fd = openSync(file, 'wx', 0o600);
  try {
    for (const entry of entries) {
      if (signal?.aborted) throw cancellationError();
      const name = validateEntryName(entry.name);
      const nameBuffer = Buffer.from(name, 'utf8');
      const crc = Number(entry.crc) >>> 0;
      const size = Number(entry.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('backup: invalid entry size');

      const local = Buffer.alloc(LOCAL_HEADER_SIZE);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(dosTime, 10);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(size, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(nameBuffer.length, 26);
      local.writeUInt16LE(0, 28);
      writeAll(fd, local);
      writeAll(fd, nameBuffer);

      if (Buffer.isBuffer(entry.data) || entry.data instanceof Uint8Array) {
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
        if (data.length !== size) throw new Error('backup: entry size mismatch');
        writeAll(fd, data);
      } else if (entry.filePath) {
        const sourceFd = openSync(entry.filePath, 'r');
        try {
          const crcState = createCrc32();
          const buffer = Buffer.alloc(CHUNK_SIZE);
          let read = 0;
          while (read < size) {
            if (signal?.aborted) throw cancellationError();
            const length = Math.min(buffer.length, size - read);
            const count = readSync(sourceFd, buffer, 0, length, read);
            if (count <= 0) {
              throw new AppError('BACKUP_SOURCE_CHANGED', {
                messageKey: 'errors.backupSourceChanged',
                details: {entry: name},
                httpStatus: 500
              });
            }
            const chunk = buffer.subarray(0, count);
            crcState.update(chunk);
            writeAll(fd, chunk);
            read += count;
            writtenBytes += count;
            onProgress?.({done: writtenBytes, total: totalBytes});
          }
          if (crcState.digest() !== crc) {
            throw new AppError('BACKUP_SOURCE_CHANGED', {
              messageKey: 'errors.backupSourceChanged',
              details: {entry: name},
              httpStatus: 500
            });
          }
        } finally {
          closeSync(sourceFd);
        }
      } else {
        throw new Error('backup: entry has no data');
      }
      if (Buffer.isBuffer(entry.data) || entry.data instanceof Uint8Array) {
        writtenBytes += size;
        onProgress?.({done: writtenBytes, total: totalBytes});
      }

      const central = Buffer.alloc(CENTRAL_HEADER_SIZE);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(dosTime, 12);
      central.writeUInt16LE(dosDate, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(size, 20);
      central.writeUInt32LE(size, 24);
      central.writeUInt16LE(nameBuffer.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(offset, 42);
      centralParts.push(central, nameBuffer);
      offset += LOCAL_HEADER_SIZE + nameBuffer.length + size;
      if (offset > 0xffffffff) {
        throw new AppError('BACKUP_TOO_LARGE', {messageKey: 'errors.backupTooLarge', httpStatus: 413});
      }
    }

    const centralDirectory = Buffer.concat(centralParts);
    writeAll(fd, centralDirectory);
    const end = Buffer.alloc(EOCD_SIZE);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    writeAll(fd, end);
    fsyncSync(fd);
    return {bytes: offset + centralDirectory.length + EOCD_SIZE};
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
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

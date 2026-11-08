import {DatabaseSync} from 'node:sqlite';
import {dirname} from 'node:path';
import {mkdirSync, statSync} from 'node:fs';

/**
 * SQLite connection factory.
 *
 * LiveMemory uses Node's built-in `node:sqlite` instead of a native addon:
 * the Windows executable can then be produced with Node's own SEA mechanism
 * without shipping compiled binaries or building native modules on user
 * machines. See docs/DECISIONS.md (ADR-002).
 */
export function openDatabase({file, memory = false, createDirectory = true} = {}) {
  if (!memory && !file) throw new Error('openDatabase: file is required');
  if (!memory && createDirectory) mkdirSync(dirname(file), {recursive: true});
  const db = new DatabaseSync(memory ? ':memory:' : file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (!memory) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA wal_autocheckpoint = 512');
  }
  return db;
}

export function closeDatabase(db) {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* checkpoint is best effort */
  }
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

/**
 * Run `fn` inside an IMMEDIATE transaction. Nested calls are rejected rather
 * than silently flattened, so aggregate updates stay atomic.
 */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* rollback failure must not hide the original error */
    }
    throw error;
  }
}

/** Total on-disk size of a database file including its WAL sidecars. */
export function databaseSizeBytes(file) {
  let total = 0;
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      total += statSync(candidate).size;
    } catch {
      /* sidecar may not exist */
    }
  }
  return total;
}

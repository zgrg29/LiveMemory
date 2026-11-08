import {openSync, writeSync, closeSync, readFileSync, rmSync, mkdirSync, existsSync} from 'node:fs';
import {dirname} from 'node:path';

/**
 * Single-instance guard per data directory.
 *
 * A second LiveMemory window must not open a second writer on the same SQLite
 * database. The lock file records the owning PID; a lock left behind by a
 * crashed process is detected and replaced.
 */

export function isProcessAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === 'EPERM';
  }
}

function readLock(lockFile) {
  try {
    return JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @returns {{acquired:boolean, lock:object|null, existing:object|null, stale:boolean}}
 */
export function acquireInstanceLock({lockFile, pid = process.pid, now = Date.now()}) {
  mkdirSync(dirname(lockFile), {recursive: true});
  const payload = {pid, startedAt: new Date(now).toISOString(), url: null};
  try {
    const fd = openSync(lockFile, 'wx');
    writeSync(fd, JSON.stringify(payload));
    closeSync(fd);
    return {
      acquired: true,
      lock: payload,
      existing: null,
      stale: false,
      release: () => {
        try {
          rmSync(lockFile, {force: true});
        } catch {
          /* ignore */
        }
      },
      update: (patch) => {
        try {
          const current = readLock(lockFile) ?? payload;
          const next = {...current, ...patch};
          const fd = openSync(lockFile, 'w');
          writeSync(fd, JSON.stringify(next));
          closeSync(fd);
        } catch {
          /* the lock file is advisory */
        }
      }
    };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const existing = readLock(lockFile);
  if (existing && isProcessAlive(existing.pid)) {
    return {acquired: false, lock: null, existing, stale: false};
  }

  // Stale lock: the owning process is gone. Take it over.
  try {
    const fd = openSync(lockFile, 'w');
    writeSync(fd, JSON.stringify(payload));
    closeSync(fd);
  } catch (error) {
    return {acquired: false, lock: null, existing, stale: true, error};
  }
  return {
    acquired: true,
    lock: payload,
    existing,
    stale: true,
    release: () => {
      try {
        rmSync(lockFile, {force: true});
      } catch {
        /* ignore */
      }
    },
    update: (patch) => {
      try {
        const current = readLock(lockFile) ?? payload;
        const fd = openSync(lockFile, 'w');
        writeSync(fd, JSON.stringify({...current, ...patch}));
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  };
}

export function readRuntimeInfo(runtimeFile) {
  if (!existsSync(runtimeFile)) return null;
  try {
    return JSON.parse(readFileSync(runtimeFile, 'utf8'));
  } catch {
    return null;
  }
}

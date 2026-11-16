import {openSync, writeSync, closeSync, readFileSync, rmSync, mkdirSync, existsSync} from 'node:fs';
import {dirname} from 'node:path';

/**
 * Single-instance guard per data directory.
 *
 * A second LiveMemory window must not open a second writer on the same SQLite
 * database. The lock file records the owning PID; a lock left behind by a
 * crashed process is detected and replaced.
 *
 * The lock file is advisory and must never crash the launcher: every filesystem
 * error is reported as data, because a non-elevated account can legitimately be
 * denied access to a folder that an elevated run created (and vice versa).
 */

export function isProcessAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else. That still
    // counts as "alive"; the caller decides whether it is *our* instance by
    // probing the recorded console URL instead of trusting the PID alone.
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

function makeHandle({lockFile, payload, existing = null, stale = false}) {
  const update = (patch) => {
    try {
      const current = readLock(lockFile) ?? payload;
      const fd = openSync(lockFile, 'w');
      writeSync(fd, JSON.stringify({...current, ...patch}));
      closeSync(fd);
    } catch {
      /* the lock file is advisory */
    }
  };
  return {
    acquired: true,
    lock: payload,
    existing,
    stale,
    release: () => {
      try {
        rmSync(lockFile, {force: true});
      } catch {
        /* ignore */
      }
    },
    update
  };
}

function failure(reason, {lockFile, error = null, existing = null, stale = false} = {}) {
  return {
    acquired: false,
    lock: null,
    existing,
    stale,
    reason,
    error,
    lockFile,
    release: () => {},
    update: () => {}
  };
}

/**
 * @returns {{acquired:boolean, reason?:'running'|'permission'|'io', error?:Error}}
 */
export function acquireInstanceLock({lockFile, pid = process.pid, now = Date.now(), exePath = process.execPath} = {}) {
  try {
    mkdirSync(dirname(lockFile), {recursive: true});
  } catch (error) {
    return failure('permission', {lockFile, error});
  }

  const payload = {
    pid,
    startedAt: new Date(now).toISOString(),
    startedAtMs: now,
    exePath,
    url: null,
    port: null
  };

  try {
    const fd = openSync(lockFile, 'wx');
    writeSync(fd, JSON.stringify(payload));
    closeSync(fd);
    return makeHandle({lockFile, payload});
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      // No write access to the runtime folder: report it as a permission
      // problem instead of throwing a raw EPERM into the console.
      return failure('permission', {lockFile, error});
    }
  }

  const existing = readLock(lockFile);
  if (existing && isProcessAlive(existing.pid)) {
    return failure('running', {lockFile, existing});
  }

  // Stale lock: the owning process is gone. Take it over.
  try {
    const fd = openSync(lockFile, 'w');
    writeSync(fd, JSON.stringify(payload));
    closeSync(fd);
  } catch (error) {
    return failure('io', {lockFile, error, existing, stale: true});
  }
  return makeHandle({lockFile, payload, existing, stale: true});
}

export function readRuntimeInfo(runtimeFile) {
  if (!existsSync(runtimeFile)) return null;
  try {
    return JSON.parse(readFileSync(runtimeFile, 'utf8'));
  } catch {
    return null;
  }
}

export const __internal = {readLock};

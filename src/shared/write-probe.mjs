import {
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  unlinkSync
} from 'node:fs';
import {join} from 'node:path';

/**
 * Real write probe for a data folder.
 *
 * `fs.accessSync(dir, W_OK)` is not a permission check on Windows: it only
 * verifies that the path exists, so a read-only folder passed the old check and
 * the failure surfaced later as an unhandled EPERM on the lock file. This probe
 * performs the operations the application actually needs (create directory,
 * create file, write, read back, delete) and reports which one failed.
 */

let probeCounter = 0;

const STEP_LABELS = Object.freeze({
  mkdir: 'mkdir',
  create: 'create',
  write: 'write',
  read: 'read',
  remove: 'remove'
});

/**
 * @returns {{ok:boolean, dir:string, step:string|null, code:string|null, error?:Error}}
 */
export function probeWritable(dir, {now = Date.now(), pid = process.pid} = {}) {
  probeCounter += 1;
  const marker = join(dir, `.lm-write-probe-${pid}-${now}-${probeCounter}`);

  try {
    mkdirSync(dir, {recursive: true});
  } catch (error) {
    return {ok: false, dir, step: STEP_LABELS.mkdir, code: error?.code ?? 'UNKNOWN', error};
  }

  let fd = null;
  try {
    fd = openSync(marker, 'wx');
  } catch (error) {
    return {ok: false, dir, step: STEP_LABELS.create, code: error?.code ?? 'UNKNOWN', error};
  }

  try {
    writeSync(fd, 'livememory');
  } catch (error) {
    closeSync(fd);
    removeQuietly(marker);
    return {ok: false, dir, step: STEP_LABELS.write, code: error?.code ?? 'UNKNOWN', error};
  }
  try {
    closeSync(fd);
  } catch {
    /* closing a written handle rarely fails; the read below is the real check */
  }

  try {
    if (readFileSync(marker, 'utf8') !== 'livememory') throw Object.assign(new Error('probe read mismatch'), {code: 'EPROBE'});
  } catch (error) {
    removeQuietly(marker);
    return {ok: false, dir, step: STEP_LABELS.read, code: error?.code ?? 'UNKNOWN', error};
  }

  try {
    unlinkSync(marker);
  } catch (error) {
    // The folder is writable but files cannot be removed: the instance lock and
    // rotated logs would accumulate. Report it instead of pretending all is well.
    return {ok: false, dir, step: STEP_LABELS.remove, code: error?.code ?? 'UNKNOWN', error};
  }

  return {ok: true, dir, step: null, code: null};
}

function removeQuietly(file) {
  try {
    unlinkSync(file);
  } catch {
    /* best effort */
  }
}

export const PROBE_STEPS = Object.freeze(Object.keys(STEP_LABELS).map((key) => STEP_LABELS[key]));

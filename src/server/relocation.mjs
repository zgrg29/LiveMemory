import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync
} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {homedir, tmpdir} from 'node:os';
import {AppError} from '../shared/errors.mjs';
import {writeDataLocation} from '../shared/data-location.mjs';
import {probeWritable} from '../shared/write-probe.mjs';
import {openDatabase, closeDatabase} from '../storage/database/connection.mjs';
import {migrate, currentSchemaVersion} from '../storage/database/migrations/index.mjs';

/**
 * Data-folder relocation.
 *
 * The old folder is never modified and never deleted. A copy is staged inside
 * the target volume, verified against the source (integrity check, table counts
 * and file checksums), then moved into place. Only after that does the launch
 * pointer change and the in-process runtime switch to the new folder. Any
 * failure rolls back to the original folder and reopens it.
 */

export const MANAGED_DIRS = Object.freeze(['config', 'database', 'secrets', 'exports', 'backups']);
const MIGRATE_COPY_DIRS = Object.freeze(['config', 'secrets', 'exports', 'backups']);
const NEW_COPY_DIRS = Object.freeze(['config', 'secrets']);
const COUNTED_TABLES = Object.freeze([
  'sessions',
  'events',
  'viewers',
  'viewer_sessions',
  'viewer_broadcasters',
  'broadcasters',
  'ai_packages',
  'app_meta'
]);

function pathKey(value) {
  return resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase();
}

export function isSubPath(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Reject roots and Windows system areas where user data must never live. */
export function isUnsafeTarget(target, {env = process.env, home = homedir()} = {}) {
  const value = pathKey(target);
  if (/^[a-z]:$/.test(value) || value === '/' || value === '') return 'drive_root';
  if (/^[a-z]:[\\/]$/.test(String(target).trim())) return 'drive_root';
  const protectedRoots = [
    env.SystemRoot ?? env.windir,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramData,
    join(home, 'AppData', 'Local', 'Microsoft', 'Windows'),
    home,
    join(home, 'Desktop'),
    join(home, 'Downloads'),
    join(home, 'Documents')
  ].filter(Boolean).map(pathKey);
  for (const root of protectedRoots) {
    if (value === root) return 'protected_root';
    // Program Files / Windows / AppData subtrees are unsafe; the user's own
    // Desktop/Downloads/Documents root is rejected, but a subfolder is allowed.
    if ((root.endsWith('\\windows') || root.includes('\\program files')) && isSubPath(root, value)) {
      return 'protected_subtree';
    }
  }
  return null;
}

function countRows(db) {
  const counts = {};
  for (const table of COUNTED_TABLES) {
    try {
      counts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
    } catch {
      counts[table] = 0;
    }
  }
  counts.schemaVersion = currentSchemaVersion(db);
  return counts;
}

function managedSize(paths) {
  let total = 0;
  for (const directory of MANAGED_DIRS) {
    const root = join(paths.root, directory);
    if (!existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      let stat;
      try {
        stat = statSync(current);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        for (const entry of readdirSync(current)) stack.push(join(current, entry));
      } else {
        total += stat.size;
      }
    }
  }
  return total;
}

function directoryHasContent(directory) {
  try {
    return existsSync(directory) && readdirSync(directory).length > 0;
  } catch {
    return true;
  }
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function fileChecksums(paths, directories) {
  const map = new Map();
  for (const directory of directories) {
    const root = join(paths.root, directory);
    if (!existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      const stat = statSync(current);
      if (stat.isDirectory()) {
        for (const entry of readdirSync(current)) stack.push(join(current, entry));
      } else {
        map.set(relative(paths.root, current).replace(/\\/g, '/'), {size: stat.size, sha256: sha256File(current)});
      }
    }
  }
  return map;
}

function removeEmptyManagedDirs(targetRoot) {
  for (const name of MANAGED_DIRS) {
    const directory = join(targetRoot, name);
    try {
      if (existsSync(directory) && statSync(directory).isDirectory() && readdirSync(directory).length === 0) {
        rmSync(directory, {recursive: false, force: true});
      }
    } catch {
      /* best effort */
    }
  }
}

function validateManagedConflicts(targetRoot) {
  for (const name of MANAGED_DIRS) {
    const directory = join(targetRoot, name);
    if (directoryHasContent(directory)) {
      const error = new AppError('RELOCATION_TARGET_IN_USE', {
        messageKey: 'errors.relocationTargetInUse',
        details: {path: directory},
        httpStatus: 409
      });
      error.path = directory;
      throw error;
    }
  }
}

/** Validate a target folder and report warnings without touching it. */
export function validateTarget({
  targetDir,
  sourceDir,
  mode = 'migrate',
  env = process.env,
  home = homedir(),
  statfs = statfsSync,
  sourceBytes = null
} = {}) {
  if (!['migrate', 'new'].includes(mode)) {
    throw new AppError('RELOCATION_INVALID', {messageKey: 'errors.relocationInvalid', httpStatus: 400});
  }
  const raw = String(targetDir ?? '').trim();
  if (!raw || raw.length > 2048 || raw.includes('\u0000')) {
    throw new AppError('RELOCATION_INVALID', {messageKey: 'errors.relocationInvalid', httpStatus: 400});
  }
  if (!isAbsolute(raw)) {
    throw new AppError('RELOCATION_INVALID', {
      messageKey: 'errors.relocationPathRelative',
      details: {path: raw},
      httpStatus: 400
    });
  }
  const target = resolve(raw);
  if (/^\\\\/.test(target)) {
    throw new AppError('RELOCATION_NETWORK_PATH', {
      messageKey: 'errors.relocationNetworkPath',
      details: {path: target},
      httpStatus: 400
    });
  }
  const unsafe = isUnsafeTarget(target, {env, home});
  if (unsafe) {
    throw new AppError('RELOCATION_UNSAFE_PATH', {
      messageKey: 'errors.relocationUnsafePath',
      details: {path: target, reason: unsafe},
      httpStatus: 400
    });
  }
  const source = resolve(String(sourceDir ?? ''));
  if (pathKey(target) === pathKey(source)) {
    throw new AppError('RELOCATION_INVALID', {
      messageKey: 'errors.relocationSamePath',
      details: {path: target},
      httpStatus: 400
    });
  }
  if (isSubPath(source, target) || isSubPath(target, source)) {
    throw new AppError('RELOCATION_INVALID', {
      messageKey: 'errors.relocationNested',
      details: {path: target},
      httpStatus: 400
    });
  }

  // The target may not exist yet. Probe the nearest existing ancestor so an
  // unwritable parent is reported before anything is copied.
  let existing = target;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  mkdirSync(existing, {recursive: true});
  const probe = probeWritable(existing);
  if (!probe.ok) {
    throw new AppError('RELOCATION_UNWRITABLE', {
      messageKey: 'errors.relocationUnwritable',
      details: {path: target, code: probe.code ?? null},
      httpStatus: 400
    });
  }
  if (existsSync(target) && !statSync(target).isDirectory()) {
    throw new AppError('RELOCATION_INVALID', {
      messageKey: 'errors.relocationNotFolder',
      details: {path: target},
      httpStatus: 400
    });
  }
  if (existsSync(target)) validateManagedConflicts(target);

  const warnings = [];
  const lowered = target.toLowerCase();
  const cloudRoots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial]
    .filter(Boolean)
    .map(pathKey);
  if (lowered.includes('\\onedrive') || cloudRoots.some((root) => isSubPath(root, lowered))) {
    warnings.push({code: 'cloud_sync', provider: 'OneDrive'});
  }
  if (lowered.includes('\\dropbox\\')) warnings.push({code: 'cloud_sync', provider: 'Dropbox'});
  if (lowered.includes('\\google drive\\') || lowered.includes('\\googledrive\\')) {
    warnings.push({code: 'cloud_sync', provider: 'Google Drive'});
  }
  if (isSubPath(tmpdir(), target)) warnings.push({code: 'temp_folder'});
  if (target.length > 180) warnings.push({code: 'long_path'});

  let freeBytes = null;
  const requiredBytes = mode === 'migrate'
    ? Math.max(0, Number(sourceBytes ?? 0)) + 50 * 1024 * 1024
    : 5 * 1024 * 1024;
  try {
    const stats = statfs(existing);
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    freeBytes = null;
  }
  if (freeBytes !== null && Number.isFinite(freeBytes) && freeBytes < requiredBytes) {
    throw new AppError('RELOCATION_NO_SPACE', {
      messageKey: 'errors.relocationNoSpace',
      details: {requiredBytes, freeBytes},
      httpStatus: 409
    });
  }

  return {
    targetDir: target,
    normalizedPath: target,
    mode,
    warnings,
    freeBytes,
    requiredBytes,
    exists: existsSync(target)
  };
}

function copyIntoStage(sourcePaths, stageRoot, names) {
  mkdirSync(stageRoot, {recursive: true});
  for (const name of names) {
    const source = join(sourcePaths.root, name);
    if (!existsSync(source)) continue;
    const destination = join(stageRoot, name);
    cpSync(source, destination, {recursive: true, force: true, errorOnExist: false});
  }
  // Database files are copied explicitly: after the WAL checkpoint the sidecars
  // may or may not exist, and copying a directory would also copy unrelated
  // files a user may have put there.
  const stageDatabase = join(stageRoot, 'database');
  mkdirSync(stageDatabase, {recursive: true});
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${sourcePaths.databaseFile}${suffix}`;
    if (!existsSync(source)) continue;
    cpSync(source, join(stageDatabase, `livememory.db${suffix}`), {force: true});
  }
}

function createFreshDatabase(stageRoot) {
  const databaseDir = join(stageRoot, 'database');
  mkdirSync(databaseDir, {recursive: true});
  const file = join(databaseDir, 'livememory.db');
  const db = openDatabase({file});
  try {
    migrate(db);
  } finally {
    closeDatabase(db);
  }
  return file;
}

function verifyDatabase(file, expectedCounts) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    const ok = integrity.length === 1 && String(integrity[0].integrity_check) === 'ok';
    if (!ok) {
      throw new AppError('RELOCATION_VERIFY_FAILED', {
        messageKey: 'errors.relocationVerifyFailed',
        details: {step: 'integrity_check'},
        httpStatus: 500
      });
    }
    const counts = countRows(db);
    if (expectedCounts) {
      for (const table of COUNTED_TABLES) {
        if (Number(counts[table] ?? 0) !== Number(expectedCounts[table] ?? 0)) {
          throw new AppError('RELOCATION_VERIFY_FAILED', {
            messageKey: 'errors.relocationVerifyFailed',
            details: {step: 'table_count', table, expected: expectedCounts[table], actual: counts[table]},
            httpStatus: 500
          });
        }
      }
      if (Number(counts.schemaVersion) !== Number(expectedCounts.schemaVersion)) {
        throw new AppError('RELOCATION_VERIFY_FAILED', {
          messageKey: 'errors.relocationVerifyFailed',
          details: {step: 'schema_version', expected: expectedCounts.schemaVersion, actual: counts.schemaVersion},
          httpStatus: 500
        });
      }
    }
    return counts;
  } finally {
    db.close();
  }
}

function moveStagedIntoPlace(stageRoot, targetRoot) {
  removeEmptyManagedDirs(targetRoot);
  validateManagedConflicts(targetRoot);
  const moved = [];
  for (const name of MANAGED_DIRS) {
    const staged = join(stageRoot, name);
    if (!existsSync(staged)) continue;
    const destination = join(targetRoot, name);
    renameSync(staged, destination);
    moved.push(name);
  }
  return moved;
}

function rollbackMoved(moved, stageRoot, targetRoot) {
  for (const name of [...moved].reverse()) {
    const destination = join(targetRoot, name);
    const staged = join(stageRoot, name);
    try {
      if (existsSync(destination) && !existsSync(staged)) {
        renameSync(destination, staged);
      }
    } catch {
      // Last resort: the folder is one LiveMemory created in this operation and
      // lives under a known managed name; remove only that folder.
      try {
        rmSync(destination, {recursive: true, force: true});
      } catch {
        /* leave for the user; original data is still intact */
      }
    }
  }
}

function countRowsFromRuntime(db) {
  return countRows(db);
}

/**
 * Move the active data folder to `targetDir`.
 * @param {{deps:object, targetDir:string, mode?:'migrate'|'new', acceptWarnings?:boolean,
 *   env?:object, now?:number, statfs?:Function}} options
 */
export async function relocateDataDir({
  deps,
  targetDir,
  mode = 'migrate',
  acceptWarnings = false,
  env = process.env,
  now = Date.now(),
  statfs = statfsSync,
  hooks = null
} = {}) {
  const runtime = deps.relocation;
  const source = runtime.current;
  const sourceDir = source.paths.root;

  const live = deps.db.prepare("SELECT 1 AS live FROM sessions WHERE status = 'live' LIMIT 1").get();
  if (live) {
    throw new AppError('RELOCATION_RECORDING', {
      messageKey: 'errors.recordingActive',
      httpStatus: 409
    });
  }

  const validation = validateTarget({
    targetDir,
    sourceDir,
    mode,
    env,
    statfs,
    sourceBytes: managedSize(source.paths)
  });
  if (validation.warnings.length > 0 && !acceptWarnings) {
    const error = new AppError('RELOCATION_WARNINGS', {
      messageKey: 'errors.relocationWarnings',
      details: {warnings: validation.warnings},
      httpStatus: 409
    });
    error.warnings = validation.warnings;
    throw error;
  }

  const sourceCounts = countRows(deps.db);
  const copiedDirs = mode === 'migrate' ? MIGRATE_COPY_DIRS : NEW_COPY_DIRS;
  const checksums = fileChecksums(source.paths, copiedDirs);
  const stageRoot = join(validation.targetDir, `.livememory-stage-${process.pid}-${now}`);
  let stopped = false;
  let next = null;
  let moved = [];
  let lockToken = null;
  let pointerWritten = false;
  let result = null;

  try {
    await runtime.stop();
    stopped = true;

    copyIntoStage(source.paths, stageRoot, copiedDirs);
    const stagedDatabase = mode === 'migrate'
      ? join(stageRoot, 'database', 'livememory.db')
      : createFreshDatabase(stageRoot);
    if (!existsSync(stagedDatabase)) {
      throw new AppError('RELOCATION_VERIFY_FAILED', {
        messageKey: 'errors.relocationVerifyFailed',
        details: {step: 'database_missing'},
        httpStatus: 500
      });
    }
    const expected = mode === 'migrate' ? sourceCounts : null;
    if (mode === 'new') {
      const counts = verifyDatabase(stagedDatabase, null);
      const nonEmpty = COUNTED_TABLES.find((table) => Number(counts[table] ?? 0) > 0);
      if (nonEmpty) {
        throw new AppError('RELOCATION_VERIFY_FAILED', {
          messageKey: 'errors.relocationVerifyFailed',
          details: {step: 'new_space_not_empty', table: nonEmpty},
          httpStatus: 500
        });
      }
    } else {
      verifyDatabase(stagedDatabase, expected);
      for (const [relativePath, checksum] of checksums) {
        const copied = join(stageRoot, relativePath);
        if (!existsSync(copied)) {
          throw new AppError('RELOCATION_VERIFY_FAILED', {
            messageKey: 'errors.relocationVerifyFailed',
            details: {step: 'missing_file', file: relativePath},
            httpStatus: 500
          });
        }
        const stat = statSync(copied);
        if (stat.size !== checksum.size || sha256File(copied) !== checksum.sha256) {
          throw new AppError('RELOCATION_VERIFY_FAILED', {
            messageKey: 'errors.relocationVerifyFailed',
            details: {step: 'checksum', file: relativePath},
            httpStatus: 500
          });
        }
      }
    }

    hooks?.afterCopy?.({stageRoot, targetDir: validation.targetDir, mode});
    moved = moveStagedIntoPlace(stageRoot, validation.targetDir);
    hooks?.afterMove?.({stageRoot, targetDir: validation.targetDir, mode, moved});
    next = runtime.build(validation.targetDir);
    const nextCounts = countRowsFromRuntime(next.db);
    const expectedNext = mode === 'migrate' ? sourceCounts : {
      sessions: 0, events: 0, viewers: 0, viewer_sessions: 0,
      viewer_broadcasters: 0, broadcasters: 0, ai_packages: 0,
      // app_meta may contain the retention bookkeeping this startup writes.
      app_meta: nextCounts.app_meta,
      schemaVersion: nextCounts.schemaVersion
    };
    for (const table of COUNTED_TABLES) {
      if (Number(nextCounts[table] ?? 0) !== Number(expectedNext[table] ?? 0)) {
        throw new AppError('RELOCATION_VERIFY_FAILED', {
          messageKey: 'errors.relocationVerifyFailed',
          details: {step: 'active_table_count', table, expected: expectedNext[table], actual: nextCounts[table]},
          httpStatus: 500
        });
      }
    }

    hooks?.beforePointer?.({targetDir: validation.targetDir, next});
    if (typeof runtime.beginLockMove === 'function') {
      lockToken = await runtime.beginLockMove({paths: next.paths, sourcePaths: source.paths});
    }
    const pointer = writeDataLocation(validation.targetDir, {env, now});
    pointerWritten = true;
    if (lockToken?.commit) await lockToken.commit();
    lockToken = null;
    runtime.swap(next);
    next = null;

    result = {
      moved: true,
      mode,
      previousDir: sourceDir,
      dataDir: validation.targetDir,
      pointerFiles: pointer.files,
      warnings: validation.warnings,
      counts: {
        before: sourceCounts,
        after: countRowsFromRuntime(runtime.current.db)
      },
      freeBytes: validation.freeBytes,
      requiredBytes: validation.requiredBytes
    };
  } catch (error) {
    try {
      if (lockToken?.abort) await lockToken.abort();
    } catch {
      /* best effort */
    }
    if (pointerWritten) {
      try {
        writeDataLocation(sourceDir, {env, now});
      } catch {
        /* the launcher can still recover with --data-dir */
      }
    }
    if (next) {
      try {
        await runtime.close(next);
      } catch {
        /* ignore */
      }
    }
    rollbackMoved(moved, stageRoot, validation.targetDir);
    if (stopped) {
      try {
        runtime.swap(runtime.build(sourceDir));
      } catch (restoreError) {
        error.restoreError = restoreError;
      }
    }
    if (error instanceof AppError) throw error;
    throw new AppError('RELOCATION_FAILED', {
      messageKey: 'errors.relocationFailed',
      details: {code: error?.code ?? 'unknown'},
      cause: error,
      httpStatus: 500
    });
  } finally {
    try {
      rmSync(stageRoot, {recursive: true, force: true});
    } catch {
      /* the staging folder is inside the target and is safe to leave behind */
    }
  }
  return result;
}

export const __internal = {
  COUNTED_TABLES,
  MANAGED_DIRS,
  countRows,
  fileChecksums,
  managedSize,
  validateManagedConflicts,
  verifyDatabase
};

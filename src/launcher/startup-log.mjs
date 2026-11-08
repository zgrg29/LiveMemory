import {appendFileSync, mkdirSync, statSync, renameSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir, tmpdir} from 'node:os';
import {redactValue} from '../server/logger.mjs';

/**
 * Startup diagnostics.
 *
 * This logger exists before the data folder, the settings file and the database,
 * because those are exactly the steps that can fail on a normal Windows account.
 * It appends JSON lines to the first writable location:
 *
 *   1. $LIVE_MEMORY_LOG_DIR                     (explicit override)
 *   2. <data folder>/logs                       (normal location)
 *   3. %TEMP%\LiveMemory-logs                   (fallback when 2 is read-only)
 *   4. ~/.livememory-logs                       (last resort)
 *
 * It also keeps the last N steps in memory so a fatal error can show what worked
 * and where the first failure happened, without the user having to open a file.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_STEPS = 64;
const MAX_STACK = 4000;

function dateStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function startupLogCandidates({env = process.env, dataDir = null, home = homedir(), temp = tmpdir()} = {}) {
  const candidates = [];
  if (env.LIVE_MEMORY_LOG_DIR) candidates.push(env.LIVE_MEMORY_LOG_DIR);
  if (dataDir) candidates.push(join(dataDir, 'logs'));
  else if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'LiveMemory', 'logs'));
  candidates.push(join(temp, 'LiveMemory-logs'));
  candidates.push(join(home, '.livememory-logs'));
  const seen = new Set();
  return candidates.filter((item) => {
    if (!item) return false;
    const key = String(item).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeStack(error) {
  const stack = String(error?.stack ?? '');
  return stack.length > MAX_STACK ? `${stack.slice(0, MAX_STACK)}…` : stack;
}

/**
 * @returns {{
 *   record: (step:string, detail?:object) => object,
 *   fail: (step:string, error:Error, detail?:object) => object,
 *   note: (step:string, detail?:object) => void,
 *   steps: () => object[],
 *   file: () => string|null,
 *   dir: () => string|null,
 *   fallback: () => boolean,
 *   describe: () => string[],
 *   writeErrorReport: (extra?:object) => string|null
 * }}
 */
export function createStartupLog({
  env = process.env,
  dataDir = null,
  now = () => new Date(),
  version = null,
  platform = process.platform,
  arch = process.arch,
  exePath = process.execPath,
  argv = [],
  cwd = process.cwd(),
  fileFor = (dir) => join(dir, `startup-${dateStamp(now())}.log`)
} = {}) {
  const records = [];
  let logDir = null;
  let logFile = null;
  let usedFallback = false;
  let writeFailed = false;

  function resolveFile() {
    if (logFile) return logFile;
    const candidates = startupLogCandidates({env, dataDir});
    for (let index = 0; index < candidates.length; index += 1) {
      const dir = candidates[index];
      try {
        mkdirSync(dir, {recursive: true});
        const file = fileFor(dir);
        const size = (() => {
          try {
            return statSync(file).size;
          } catch {
            return 0;
          }
        })();
        if (size > MAX_BYTES) {
          // Keep one previous file for support instead of deleting evidence.
          try {
            renameSync(file, `${file}.1`);
          } catch {
            /* ignore */
          }
        }
        logDir = dir;
        logFile = file;
        usedFallback = index > 0;
        return logFile;
      } catch {
        /* try the next location */
      }
    }
    return null;
  }

  function append(entry) {
    const file = resolveFile();
    if (!file) {
      writeFailed = true;
      return;
    }
    try {
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      writeFailed = true;
    }
  }

  function push(step, detail = {}) {
    const at = now().toISOString();
    const entry = redactValue({
      at,
      level: detail.ok === false ? 'error' : 'info',
      step,
      pid: process.pid,
      ...detail
    });
    records.push(entry);
    if (records.length > MAX_STEPS) records.shift();
    append(entry);
    return entry;
  }

  function record(step, detail = {}) {
    return push(step, {...detail, ok: detail.ok !== false});
  }

  function fail(step, error, detail = {}) {
    return push(step, {
      ...detail,
      ok: false,
      code: error?.code ?? detail.code ?? 'UNKNOWN',
      message: error?.message ?? String(error),
      stack: safeStack(error)
    });
  }

  record('startup.begin', {
    version,
    platform,
    arch,
    node: process.versions.node,
    exePath,
    cwd,
    argv: argv.map((item) => String(item)),
    dataDirEnv: env.LIVE_MEMORY_DATA_DIR ?? null,
    localAppData: env.LOCALAPPDATA ?? null
  });

  return {
    record,
    fail,
    note(step, detail = {}) {
      record(step, detail);
    },
    steps: () => records.map((entry) => ({...entry})),
    file: () => resolveFile(),
    dir: () => {
      resolveFile();
      return logDir;
    },
    fallback: () => {
      resolveFile();
      return usedFallback;
    },
    /**
     * Move the log into the resolved data folder once it is known, so the path
     * printed in the console ("Log folder") actually contains the startup log.
     * The early records are copied over so nothing is lost.
     */
    relocate(dataDir) {
      if (!dataDir) return false;
      const targetDir = join(dataDir, 'logs');
      if (logDir && resolve(logDir) === resolve(targetDir)) return true;
      const targetFile = fileFor(targetDir);
      try {
        mkdirSync(targetDir, {recursive: true});
        appendFileSync(targetFile, records.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
      } catch {
        return false;
      }
      logDir = targetDir;
      logFile = targetFile;
      usedFallback = false;
      return true;
    },
    writeFailed: () => writeFailed,
    lastFailure: () => records.filter((entry) => entry.ok === false).at(-1) ?? null,
    describe() {
      const lines = [];
      let logged = false;
      for (const entry of records) {
        if (entry.step === 'startup.begin') continue;
        const mark = entry.ok === false ? 'failed' : 'ok';
        if (!logged && entry.ok === false) {
          lines.push(`  ${mark} ${entry.step}${entry.code ? ` (${entry.code})` : ''}${entry.message ? ` — ${entry.message}` : ''}`);
          logged = true;
        } else if (!logged) {
          lines.push(`  ${mark} ${entry.step}`);
        }
      }
      return lines;
    },
    writeErrorReport(extra = {}) {
      const file = resolveFile();
      if (!file) return null;
      const reportFile = join(logDir ?? '', 'startup-error.json');
      try {
        writeFileSync(reportFile, `${JSON.stringify(redactValue({
          at: now().toISOString(),
          version,
          platform,
          arch,
          node: process.versions.node,
          exePath,
          cwd,
          ...extra,
          steps: records.slice(-MAX_STEPS)
        }), null, 2)}\n`, 'utf8');
        return reportFile;
      } catch {
        return null;
      }
    }
  };
}

import {appendFileSync, mkdirSync, statSync, renameSync, existsSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Structured file logger.
 *
 * Rules (see docs/PRIVACY_SECURITY.md):
 * - credentials never reach the log: cookie/token/secret keys and values are
 *   redacted before serialisation;
 * - chat message bodies are not logged, only event kinds and counts;
 * - the visible console gets a few human lines, the file gets the details.
 */

const SECRET_KEY = /(cookie|sessdata|bili_jct|token|secret|password|passwd|authorization|api[-_]?key|credential|session[-_]?key)/i;
const SECRET_VALUE_PATTERNS = [
  /SESSDATA=[^;\s]+/gi,
  /bili_jct=[^;\s]+/gi,
  /DedeUserID=[^;\s]+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /("(?:token|cookie|apiKey|api_key|secret|password)"\s*:\s*")[^"]*(")/gi
];

const MAX_STRING = 240;
const MAX_BYTES = 5 * 1024 * 1024;

export function redactValue(value, depth = 0) {
  if (depth > 4) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let text = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    for (const pattern of SECRET_VALUE_PATTERNS) text = text.replace(pattern, (match, prefix, suffix) => {
      if (suffix !== undefined && prefix !== undefined) return `${prefix}[redacted]${suffix}`;
      const name = match.split('=')[0];
      return `${name}=[redacted]`;
    });
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) output[key] = '[redacted]';
      else output[key] = redactValue(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

function dateStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function createLogger({dir, level = 'info', consoleEcho = false, now = () => new Date()} = {}) {
  const levels = {debug: 10, info: 20, warn: 30, error: 40};
  const threshold = levels[level] ?? levels.info;
  if (dir) mkdirSync(dir, {recursive: true});

  function write(levelName, payload) {
    if (levels[levelName] < threshold) return;
    const at = now();
    const record = {
      at: at.toISOString(),
      level: levelName,
      pid: process.pid,
      ...redactValue(payload ?? {})
    };
    if (dir) {
      const file = join(dir, `livememory-${dateStamp(at)}.log`);
      try {
        if (existsSync(file) && statSync(file).size > MAX_BYTES) {
          renameSync(file, `${file}.1`);
        }
        appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      } catch {
        /* logging must never crash the app */
      }
    }
    if (consoleEcho && levelName !== 'debug') {
      const prefix = levelName === 'error' ? 'ERROR' : levelName === 'warn' ? 'WARN ' : 'INFO ';
      process.stderr.write(`${prefix} ${record.event ?? record.msg ?? ''}\n`);
    }
  }

  return {
    debug: (payload) => write('debug', payload),
    info: (payload) => write('info', payload),
    warn: (payload) => write('warn', payload),
    error: (payload) => write('error', payload),
    fileFor(date = now()) {
      return join(dir, `livememory-${dateStamp(date)}.log`);
    }
  };
}

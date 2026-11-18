import * as real from 'node:fs';

/**
 * Test-only file-system wrapper with deterministic failures.
 *
 * The provider config store deliberately takes an injectable `fs` object so a
 * failed rename/write can be tested without making the real user data folder
 * read-only (which would be dangerous and non-portable).
 */
export function faultyFs({onWrite = null, onRename = null, onRemove = null} = {}) {
  const fail = (code, path) => {
    const error = new Error(`${code}: injected failure`);
    error.code = code;
    if (path) error.path = path;
    throw error;
  };
  return {
    existsSync: (path) => real.existsSync(path),
    mkdirSync: (path, options) => real.mkdirSync(path, options),
    readFileSync: (path, options) => real.readFileSync(path, options),
    writeFileSync: (path, data, options) => {
      const code = onWrite?.(String(path));
      if (code) fail(code, String(path));
      return real.writeFileSync(path, data, options);
    },
    renameSync: (from, to) => {
      const code = onRename?.(String(to), String(from));
      if (code) fail(code, String(to));
      return real.renameSync(from, to);
    },
    rmSync: (path, options) => {
      const code = onRemove?.(String(path));
      if (code) fail(code, String(path));
      return real.rmSync(path, options);
    }
  };
}

export const __internal = {real};

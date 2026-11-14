import {MIN_NODE_MAJOR, MIN_NODE_MINOR} from '../shared/app-info.mjs';

/** Runtime checks that must run before the database layer is imported. */
export function checkNodeVersion(version = process.versions.node) {
  const [majorText, minorText] = String(version).split('.');
  const major = Number(majorText);
  const minor = Number(minorText);
  const ok = Number.isInteger(major) && (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR));
  return {
    ok,
    actual: String(version),
    expected: `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`
  };
}

/** node:sqlite ships with Node 22.5+; verify rather than assume. */
export async function checkSqliteSupport() {
  try {
    const module = await import('node:sqlite');
    return {ok: typeof module.DatabaseSync === 'function'};
  } catch (error) {
    return {ok: false, error};
  }
}

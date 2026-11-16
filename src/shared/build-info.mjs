/**
 * Build identity.
 *
 * The version string alone cannot distinguish two builds (both v0.13.1 builds
 * looked identical). This module exposes the Git commit, the packaged asset
 * hash and a stable `buildId` so the startup log, the console banner and the
 * About card can prove which code is actually running.
 *
 * Packaged runs receive the identity from `build-info.json` (written by the
 * build script) and the environment variables set by the SEA bootstrap after it
 * verified the extracted files. Development runs read `.git/HEAD` directly and
 * never spawn git.
 */

import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {APP_VERSION} from './app-info.mjs';

const SHARED_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(SHARED_DIR, '..', '..');

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file) {
  const text = readText(file);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function readGitCommit(root = SOURCE_ROOT) {
  const gitDir = join(root, '.git');
  const head = readText(join(gitDir, 'HEAD'));
  if (!head) return null;
  const value = head.trim();
  if (/^[0-9a-f]{7,64}$/i.test(value)) return value;
  const match = /^ref:\s*(.+)$/i.exec(value);
  if (!match) return null;
  const ref = match[1].trim();
  const direct = readText(join(gitDir, ref));
  if (direct) return direct.trim();
  // A packed ref is the normal state after `git gc`.
  const packed = readText(join(gitDir, 'packed-refs'));
  if (packed) {
    for (const line of packed.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const [hash, name] = line.trim().split(/\s+/);
      if (name === ref && /^[0-9a-f]{7,64}$/i.test(hash)) return hash;
    }
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * @returns {{
 *   version:string,
 *   commit:string|null,
 *   shortCommit:string|null,
 *   builtAt:string|null,
 *   sourceHash:string|null,
 *   assetHash:string|null,
 *   buildId:string,
 *   mode:'packaged'|'source',
 *   verified:boolean|null,
 *   appRoot:string|null
 * }}
 */
export function readBuildInfo({env = process.env, appRoot = null, sourceRoot = SOURCE_ROOT} = {}) {
  const roots = [appRoot, sourceRoot].filter(Boolean);
  let packaged = null;
  let packagedFrom = null;
  for (const root of roots) {
    const candidate = readJson(join(root, 'build-info.json'));
    if (candidate) {
      packaged = candidate;
      packagedFrom = root;
      break;
    }
  }
  const sourceCommit = readGitCommit(sourceRoot);
  const commit = firstString(
    env.LIVE_MEMORY_BUILD_COMMIT,
    packaged?.commit,
    sourceCommit
  );
  const shortCommit = firstString(
    env.LIVE_MEMORY_BUILD_SHORT,
    packaged?.shortCommit,
    commit ? commit.slice(0, 7) : null
  );
  const version = firstString(
    env.LIVE_MEMORY_BUILD_VERSION,
    packaged?.version,
    APP_VERSION
  );
  const assetHash = firstString(
    env.LIVE_MEMORY_ASSET_HASH,
    packaged?.assetHash
  );
  const sourceHash = firstString(
    env.LIVE_MEMORY_BUILD_SOURCE_HASH,
    packaged?.sourceHash
  );
  const builtAt = firstString(
    env.LIVE_MEMORY_BUILD_TIME,
    packaged?.builtAt
  );
  const buildId = firstString(
    env.LIVE_MEMORY_BUILD_ID,
    packaged?.buildId,
    shortCommit && sourceHash ? `${shortCommit}.${sourceHash.slice(0, 8)}` : null,
    shortCommit ? `dev-${shortCommit}` : null,
    `dev-${version}`
  );
  const verify = String(env.LIVE_MEMORY_BUILD_VERIFY ?? '').toLowerCase();
  return {
    version,
    commit,
    shortCommit,
    builtAt,
    sourceHash,
    assetHash,
    buildId,
    mode: appRoot || env.LIVE_MEMORY_APP_ROOT ? 'packaged' : 'source',
    verified: verify === 'ok' ? true : (verify === 'failed' ? false : null),
    appRoot: appRoot ?? (env.LIVE_MEMORY_APP_ROOT ? String(env.LIVE_MEMORY_APP_ROOT) : null),
    infoFile: packagedFrom ? join(packagedFrom, 'build-info.json') : null
  };
}

/** One-line identity used by logs and the console. Never includes user data. */
export function describeBuild(info) {
  if (!info) return 'unknown build';
  const commit = info.shortCommit ? `commit ${info.shortCommit}` : 'commit unknown';
  const assets = info.assetHash ? `assets ${info.assetHash}` : 'assets unknown';
  const built = info.builtAt ? `, built ${info.builtAt}` : '';
  return `${info.version} (${commit}, ${assets}${built})`;
}

export function buildSummary(info) {
  if (!info) return null;
  return {
    version: info.version,
    buildId: info.buildId,
    commit: info.commit,
    shortCommit: info.shortCommit,
    builtAt: info.builtAt,
    sourceHash: info.sourceHash,
    assetHash: info.assetHash,
    mode: info.mode,
    verified: info.verified
  };
}

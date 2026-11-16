import {existsSync, readdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';

/**
 * Safe cleanup of the retired TikTok browser-relay artifacts.
 *
 * Earlier releases could open a dedicated Chrome/Edge profile and a login-state
 * file for TikTok. The unified anonymous WebSocket capture needs neither. This
 * module removes *only* the paths LiveMemory itself created:
 *
 *   <dataDir>/browser/tiktok/login-state.json      login marker (no cookies)
 *   <dataDir>/browser/tiktok/account/              dedicated profile
 *
 * The profile is deleted only when it carries LiveMemory's own marker
 * (`.livememory-owned`), so a directory that happens to sit there for another
 * reason is left untouched. Nothing outside `<dataDir>/browser/tiktok` is read
 * or removed, which means the user's normal Chrome/Edge profiles can never be
 * touched.
 */

export const LEGACY_BROWSER_DIR = ['browser', 'tiktok'];
export const LEGACY_PROFILE_DIR = 'account';
export const LEGACY_STATE_FILE = 'login-state.json';
export const OWNED_MARKER = '.livememory-owned';

function isInside(parent, child) {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(`${root}${sep}`);
}

export function inspectLegacyTikTokArtifacts(dataDir) {
  if (!dataDir) return {supported: false, present: false, reasons: ['no_data_dir']};
  const base = join(dataDir, ...LEGACY_BROWSER_DIR);
  const profile = join(base, LEGACY_PROFILE_DIR);
  const stateFile = join(base, LEGACY_STATE_FILE);
  const marker = join(profile, OWNED_MARKER);
  const present = existsSync(base);
  return {
    supported: true,
    present,
    base,
    profile,
    stateFile,
    profileExists: existsSync(profile),
    profileOwned: existsSync(marker),
    stateExists: existsSync(stateFile),
    /** True when there is something this module is allowed to delete. */
    hasOwnedArtifacts: (existsSync(marker) && existsSync(profile)) || existsSync(stateFile)
  };
}

/**
 * Remove the retired artifacts. Returns a report; never throws for a missing
 * directory and never deletes anything it cannot prove LiveMemory owns.
 */
export function cleanupLegacyTikTokArtifacts(dataDir, {logger = null, fs = null} = {}) {
  const api = fs ?? {existsSync, readdirSync, readFileSync, rmSync, statSync};
  const report = {removed: [], skipped: [], errors: [], ownedProfileRemoved: false, stateFileRemoved: false};
  if (!dataDir) {
    report.skipped.push({path: null, reason: 'no_data_dir'});
    return report;
  }
  const base = join(dataDir, ...LEGACY_BROWSER_DIR);
  const profile = join(base, LEGACY_PROFILE_DIR);
  const stateFile = join(base, LEGACY_STATE_FILE);
  const marker = join(profile, OWNED_MARKER);

  if (!api.existsSync(base)) return report;

  // Defensive: the resolved paths must stay inside the data directory.
  for (const target of [base, profile, stateFile]) {
    if (!isInside(dataDir, target)) {
      report.errors.push({path: target, reason: 'outside_data_dir'});
      return report;
    }
  }

  if (api.existsSync(stateFile)) {
    try {
      api.rmSync(stateFile, {force: true});
      report.removed.push(stateFile);
      report.stateFileRemoved = true;
    } catch (error) {
      report.errors.push({path: stateFile, reason: error?.code ?? 'remove_failed'});
    }
  }

  if (api.existsSync(profile)) {
    let owned = false;
    try {
      owned = api.existsSync(marker) && api.readFileSync(marker, 'utf8').startsWith('LiveMemory dedicated');
    } catch (error) {
      report.errors.push({path: marker, reason: error?.code ?? 'marker_unreadable'});
    }
    if (!owned) {
      // Not provably ours: keep it and say why. This is the guard that protects
      // any unrelated profile directory a user might have put there.
      report.skipped.push({path: profile, reason: 'marker_missing_or_unexpected'});
    } else {
      try {
        api.rmSync(profile, {recursive: true, force: true, maxRetries: 3});
        report.removed.push(profile);
        report.ownedProfileRemoved = true;
      } catch (error) {
        report.errors.push({path: profile, reason: error?.code ?? 'remove_failed'});
      }
    }
  }

  // Remove the now-empty parent only; a non-empty directory is left alone.
  try {
    if (api.existsSync(base) && api.readdirSync(base).length === 0) {
      api.rmSync(base, {recursive: true, force: true});
      report.removed.push(base);
    }
  } catch (error) {
    report.errors.push({path: base, reason: error?.code ?? 'remove_failed'});
  }

  if (report.removed.length > 0) {
    logger?.info({event: 'tiktok.legacy.cleanup', removed: report.removed.length, ownedProfileRemoved: report.ownedProfileRemoved});
  }
  if (report.errors.length > 0) {
    logger?.warn({event: 'tiktok.legacy.cleanup.failed', errors: report.errors.map((entry) => entry.reason)});
  }
  return report;
}

export const __internal = {isInside};

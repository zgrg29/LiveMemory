import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * Local state for the anonymous TikTok WebSocket capture.
 *
 * Only one artifact exists: the anonymous `ttwid` device cookie TikTok issues to
 * any visitor. It is not a login, it contains no account identity and no token,
 * but caching it avoids asking TikTok for a fresh one on every launch (TikTok
 * throttles bursts of page requests) and lets a capture survive a restart when
 * the platform is briefly refusing new device cookies.
 *
 * The file lives under the user's data directory and is never included in
 * exports, AI packages or backups.
 */
export const TTWID_DIR = 'tiktok';
export const TTWID_FILE = 'ttwid.json';

export function ttwidPath(dataDir) {
  return dataDir ? join(dataDir, TTWID_DIR, TTWID_FILE) : null;
}

export function createTtwidStore(dataDir, {fs = {mkdir, readFile, writeFile}} = {}) {
  const path = ttwidPath(dataDir);
  if (!path) return null;
  return {
    path,
    async read() {
      try {
        const text = await fs.readFile(path, 'utf8');
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.ttwid === 'string' && parsed.ttwid.length > 20) return parsed;
        return null;
      } catch {
        return null;
      }
    },
    async write(value) {
      await fs.mkdir(join(dataDir, TTWID_DIR), {recursive: true});
      await fs.writeFile(path, `${JSON.stringify({ttwid: value.ttwid, fetchedAt: value.fetchedAt ?? Date.now()}, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
    }
  };
}

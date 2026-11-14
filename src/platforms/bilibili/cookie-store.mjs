import {createCipheriv, createDecipheriv, randomBytes, scryptSync} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {spawnSync} from 'node:child_process';

/**
 * Encrypted Bilibili credential store.
 *
 * The cookie is written as AES-256-GCM ciphertext. The key lives in the same
 * per-user folder with a restrictive ACL (Windows) / mode 0600 (POSIX). This is
 * protection at rest against another Windows account and against accidental
 * inclusion in logs or backups — it is *not* equivalent to DPAPI: a process
 * running as the same Windows user can read both files.
 *
 * Nothing in this module ever logs a cookie value.
 */

const FILE_VERSION = 1;
const SECRET_NAMES = /^(SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|sid|buvid3|buvid4|b_nut|buvid2)$/;

export function parseCookieNames(header) {
  return String(header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split('=')[0])
    .filter(Boolean);
}

export function isSecretCookieName(name) {
  return SECRET_NAMES.test(String(name ?? ''));
}

/** Keep only the platform cookie names the project actually needs. */
export function sanitizeCookie(header, {allow = null} = {}) {
  const allowed = allow ?? SECRET_NAMES;
  return String(header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes('='))
    .filter((part) => allowed.test(part.split('=')[0]))
    .join('; ');
}

/** Cookies from `Set-Cookie` lines and from the login redirect URL. */
export function extractLoginCookies({setCookies = [], url = null} = {}) {
  const jar = new Map();
  if (url) {
    try {
      const parsed = new URL(url);
      for (const [name, value] of parsed.searchParams) {
        if (isSecretCookieName(name) && value) jar.set(name, value);
      }
    } catch {
      /* not a URL, ignore */
    }
  }
  for (const line of setCookies) {
    const pair = String(line ?? '').split(';')[0]?.trim();
    if (!pair || !pair.includes('=')) continue;
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (isSecretCookieName(name) && value) jar.set(name, value);
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function hasSessionCookie(cookieHeader) {
  return /(?:^|;\s*)SESSDATA=([^;]+)/.test(String(cookieHeader ?? ''))
    && !/SESSDATA=\s*(?:;|$)/.test(String(cookieHeader ?? ''));
}

export class CookieStore {
  constructor({dir, file = null, keyFile = null, fs = null} = {}) {
    this.dir = dir;
    this.file = file ?? join(dir, 'bilibili-login.json');
    this.keyFile = keyFile ?? join(dir, '.bilibili-key');
    this.fs = fs ?? {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync};
    this.cache = null;
  }

  #key() {
    try {
      const existing = this.fs.readFileSync(this.keyFile, 'utf8').trim();
      if (existing.length >= 32) return Buffer.from(existing, 'base64');
    } catch {
      /* create below */
    }
    const key = randomBytes(32);
    this.fs.mkdirSync(dirname(this.keyFile), {recursive: true});
    this.fs.writeFileSync(this.keyFile, key.toString('base64'), {mode: 0o600});
    this.restrictPermissions(this.keyFile);
    return key;
  }

  /** Best effort: only the current account may read the key/ciphertext. */
  restrictPermissions(target) {
    if (process.platform !== 'win32') return {ok: false, reason: 'not-windows'};
    try {
      const user = process.env.USERNAME;
      if (!user) return {ok: false, reason: 'no-user'};
      const result = spawnSync('icacls', [target, '/inheritance:r', '/grant:r', `${user}:(R,W)`], {
        stdio: 'ignore',
        windowsHide: true
      });
      return {ok: result.status === 0};
    } catch {
      return {ok: false, reason: 'icacls-failed'};
    }
  }

  load() {
    try {
      const raw = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      if (raw?.version !== FILE_VERSION || !raw?.payload) return null;
      const key = this.#key();
      const iv = Buffer.from(raw.iv, 'base64');
      const tag = Buffer.from(raw.tag, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(Buffer.from(raw.payload, 'base64')),
        decipher.final()
      ]).toString('utf8');
      const parsed = JSON.parse(plain);
      if (!parsed?.cookie || !hasSessionCookie(parsed.cookie)) return null;
      this.cache = {
        cookie: parsed.cookie,
        uid: parsed.uid ?? null,
        name: parsed.name ?? null,
        savedAt: raw.savedAt ?? null
      };
      return {...this.cache};
    } catch {
      return null;
    }
  }

  save({cookie, uid = null, name = null, now = Date.now()}) {
    if (!cookie || !hasSessionCookie(cookie)) throw new Error('refusing to save a cookie without SESSDATA');
    const key = this.#key();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const payload = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify({cookie, uid, name}), 'utf8')),
      cipher.final()
    ]);
    this.fs.mkdirSync(dirname(this.file), {recursive: true});
    const temp = `${this.file}.tmp`;
    this.fs.writeFileSync(temp, `${JSON.stringify({
      version: FILE_VERSION,
      savedAt: new Date(now).toISOString(),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      payload: payload.toString('base64')
    }, null, 2)}\n`, {mode: 0o600});
    this.fs.renameSync(temp, this.file);
    this.restrictPermissions(this.file);
    this.cache = {cookie, uid, name, savedAt: new Date(now).toISOString()};
    return {uid, name, savedAt: this.cache.savedAt};
  }

  clear() {
    this.cache = null;
    try {
      this.fs.rmSync(this.file, {force: true});
    } catch {
      /* already gone */
    }
    return true;
  }

  /** Never returns the cookie; safe for HTTP responses. */
  status() {
    const value = this.cache ?? this.load();
    return {
      stored: Boolean(value?.cookie),
      uid: value?.uid ?? null,
      name: value?.name ?? null,
      savedAt: value?.savedAt ?? null
    };
  }

  cookie() {
    const value = this.cache ?? this.load();
    return value?.cookie ?? '';
  }
}

import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {spawnSync} from 'node:child_process';

/**
 * Encrypted JSON store for platform credentials (AES-256-GCM + per-install key).
 *
 * Scope of the protection, stated honestly:
 * - protects against another Windows account reading the file;
 * - protects against accidental leakage into logs, backups or a Git checkout;
 * - it is *not* DPAPI: a process running as the same Windows user can read both
 *   the key and the ciphertext. The key and the ciphertext are restricted with
 *   `icacls` on a best-effort basis.
 *
 * The store never logs a value.
 */

const FILE_VERSION = 1;

export class CredentialStoreError extends Error {
  constructor(code, {path = null, cause = null} = {}) {
    super(code);
    this.name = 'CredentialStoreError';
    this.code = code;
    if (path) this.path = path;
    if (cause) this.cause = cause;
  }
}

export class EncryptedJsonStore {
  constructor({
    dir,
    fileName,
    keyFileName,
    fs = {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync},
    platform = process.platform,
    user = process.env.USERNAME,
    // Strict mode never regenerates an existing key that cannot be decoded.
    // Regeneration would silently make every saved secret undecryptable. The
    // provider credential store opts in; platform cookie stores keep their
    // historical recovery behaviour.
    strictKey = false
  }) {
    if (!dir) throw new Error('EncryptedJsonStore: dir is required');
    if (!fileName) throw new Error('EncryptedJsonStore: fileName is required');
    this.dir = dir;
    this.file = join(dir, fileName);
    this.keyFile = join(dir, keyFileName ?? `.${fileName}.key`);
    this.fs = fs;
    this.platform = platform;
    this.user = user;
    this.strictKey = strictKey;
  }

  #keyFileExists() {
    try {
      return Boolean(this.fs.existsSync?.(this.keyFile));
    } catch {
      return false;
    }
  }

  /** Read the existing key; never creates one and never silently replaces it. */
  #readKey() {
    let existing = null;
    try {
      existing = String(this.fs.readFileSync(this.keyFile, 'utf8')).trim();
    } catch (error) {
      throw new CredentialStoreError('CREDENTIAL_KEY_UNREADABLE', {
        path: this.keyFile,
        cause: error
      });
    }
    const decoded = Buffer.from(existing, 'base64');
    if (existing.length === 0 || decoded.length !== 32) {
      throw new CredentialStoreError('CREDENTIAL_KEY_INVALID', {path: this.keyFile});
    }
    return decoded;
  }

  #key() {
    if (this.#keyFileExists()) {
      try {
        return this.#readKey();
      } catch (error) {
        if (this.strictKey) throw error;
        // Historical behaviour for platform cookie stores: a malformed key is
        // treated as a fresh install. Existing ciphertext is unreadable anyway.
      }
    }
    const key = randomBytes(32);
    this.fs.mkdirSync(dirname(this.keyFile), {recursive: true});
    this.fs.writeFileSync(this.keyFile, key.toString('base64'), {mode: 0o600});
    this.restrictPermissions(this.keyFile);
    return key;
  }

  /** Best effort: only the current account may read the key/ciphertext. */
  restrictPermissions(target) {
    if (this.platform !== 'win32') return {ok: false, reason: 'not-windows'};
    try {
      if (!this.user) return {ok: false, reason: 'no-user'};
      const result = spawnSync('icacls', [target, '/inheritance:r', '/grant:r', `${this.user}:(R,W)`], {
        stdio: 'ignore',
        windowsHide: true
      });
      return {ok: result.status === 0};
    } catch {
      return {ok: false, reason: 'icacls-failed'};
    }
  }

  /**
   * Read the store and classify why it could not be read.
   *
   * `load()` used to return `null` for a missing file, a corrupt ciphertext and
   * a missing key alike. The provider store then treated all three as an empty
   * store and its next save replaced every existing credential. The explicit
   * error lets callers distinguish "first run" from "do not overwrite".
   *
   * @returns {{data: object|null, savedAt: string|null, error: string|null}}
   */
  loadDetailed() {
    let text;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      return {
        data: null,
        savedAt: null,
        error: error?.code === 'ENOENT' ? 'CREDENTIAL_STORE_MISSING' : 'CREDENTIAL_STORE_UNREADABLE'
      };
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return {data: null, savedAt: null, error: 'CREDENTIAL_STORE_INVALID'};
    }
    if (raw?.version !== FILE_VERSION || typeof raw?.payload !== 'string' || !raw.iv || !raw.tag) {
      return {data: null, savedAt: null, error: 'CREDENTIAL_STORE_INVALID'};
    }

    if (!this.#keyFileExists()) {
      return {data: null, savedAt: null, error: 'CREDENTIAL_KEY_MISSING'};
    }
    let key;
    try {
      key = this.#readKey();
    } catch (error) {
      return {
        data: null,
        savedAt: null,
        error: error?.code === 'CREDENTIAL_KEY_INVALID'
          ? 'CREDENTIAL_KEY_INVALID'
          : 'CREDENTIAL_KEY_UNREADABLE'
      };
    }

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(raw.payload, 'base64')),
        decipher.final()
      ]).toString('utf8');
      const data = JSON.parse(plain);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return {data: null, savedAt: null, error: 'CREDENTIAL_STORE_INVALID'};
      }
      return {data, savedAt: raw.savedAt ?? null, error: null};
    } catch {
      return {data: null, savedAt: null, error: 'CREDENTIAL_STORE_UNREADABLE'};
    }
  }

  /** @returns {{data: object, savedAt: string|null}|null} */
  load() {
    return this.loadDetailed().data;
  }

  save(data, {now = Date.now()} = {}) {
    const key = this.#key();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const payload = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(data), 'utf8')),
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
    return {savedAt: new Date(now).toISOString()};
  }

  clear() {
    try {
      this.fs.rmSync(this.file, {force: true});
    } catch {
      /* already gone */
    }
    return true;
  }

  exists() {
    try {
      return Boolean(this.fs.existsSync(this.file));
    } catch {
      return false;
    }
  }
}

export const __internal = {FILE_VERSION};

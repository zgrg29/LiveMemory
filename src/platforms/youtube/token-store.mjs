import {EncryptedJsonStore} from '../shared/secret-store.mjs';

/**
 * Encrypted YouTube OAuth credential store.
 *
 * The refresh token is the long-lived secret: it can read the streamer's own
 * channel metadata and any live chat the granted scope allows. It is therefore
 * written as AES-256-GCM ciphertext under `<data dir>/secrets/`, with a
 * per-install key, and is never returned by an API, written to a log, embedded
 * in an AI package or included in a backup.
 *
 * Backup note: moving to another computer intentionally requires signing in
 * again, because the key file stays with the installation. That is a deliberate
 * trade-off, not a bug.
 */

const FILE_NAME = 'youtube-oauth.json';
const KEY_FILE_NAME = '.youtube-oauth-key';
const MAX_TOKEN_LENGTH = 4096;

function cleanToken(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_TOKEN_LENGTH) return null;
  return text;
}

function cleanChannel(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id.slice(0, 64).trim() : '';
  const title = typeof value.title === 'string' ? value.title.slice(0, 200).trim() : '';
  if (!id && !title) return null;
  return {id: id || null, title: title || null};
}

export class YouTubeTokenStore {
  constructor({dir, store = null, fs = null} = {}) {
    this.file = new EncryptedJsonStore({
      dir,
      fileName: FILE_NAME,
      keyFileName: KEY_FILE_NAME,
      ...(fs ? {fs} : {})
    });
    this.store = store;
    this.cache = null;
    this.loaded = false;
  }

  #read() {
    if (this.loaded) return this.cache;
    this.loaded = true;
    const stored = this.file.load();
    if (!stored) {
      this.cache = null;
      return null;
    }
    const {data, savedAt} = stored;
    const refreshToken = cleanToken(data.refreshToken);
    const accessToken = cleanToken(data.accessToken);
    if (!refreshToken && !accessToken) {
      this.cache = null;
      return null;
    }
    this.cache = {
      refreshToken,
      accessToken,
      expiresAt: Number.isFinite(Number(data.expiresAt)) ? Number(data.expiresAt) : null,
      scope: typeof data.scope === 'string' ? data.scope.slice(0, 500) : null,
      tokenType: typeof data.tokenType === 'string' ? data.tokenType.slice(0, 32) : 'Bearer',
      channel: cleanChannel(data.channel),
      savedAt: savedAt ?? null
    };
    return this.cache;
  }

  load() {
    const value = this.#read();
    return value ? {...value} : null;
  }

  /** @param {{accessToken?:string, refreshToken?:string, expiresAt?:number, scope?:string, tokenType?:string}} tokens */
  saveTokens(tokens, {now = Date.now()} = {}) {
    const previous = this.#read();
    const next = {
      refreshToken: cleanToken(tokens.refreshToken) ?? previous?.refreshToken ?? null,
      accessToken: cleanToken(tokens.accessToken) ?? previous?.accessToken ?? null,
      expiresAt: Number.isFinite(Number(tokens.expiresAt)) ? Number(tokens.expiresAt) : previous?.expiresAt ?? null,
      scope: typeof tokens.scope === 'string' ? tokens.scope.slice(0, 500) : previous?.scope ?? null,
      tokenType: typeof tokens.tokenType === 'string' ? tokens.tokenType.slice(0, 32) : previous?.tokenType ?? 'Bearer',
      channel: cleanChannel(tokens.channel) ?? previous?.channel ?? null
    };
    if (!next.refreshToken && !next.accessToken) throw new Error('refusing to save an empty YouTube credential');
    const {savedAt} = this.file.save(next, {now});
    this.loaded = true;
    this.cache = {...next, savedAt};
    return this.load();
  }

  setChannel(channel) {
    const current = this.#read();
    if (!current) return null;
    const merged = {...current, channel: cleanChannel(channel) ?? current.channel};
    const {savedAt} = this.file.save({
      refreshToken: merged.refreshToken,
      accessToken: merged.accessToken,
      expiresAt: merged.expiresAt,
      scope: merged.scope,
      tokenType: merged.tokenType,
      channel: merged.channel
    });
    this.cache = {...merged, savedAt};
    return this.load();
  }

  clear() {
    this.loaded = true;
    this.cache = null;
    return this.file.clear();
  }

  /** Never returns a token. */
  status() {
    const value = this.#read();
    return {
      stored: Boolean(value),
      hasRefreshToken: Boolean(value?.refreshToken),
      channel: value?.channel ?? null,
      expiresAt: value?.expiresAt ?? null,
      savedAt: value?.savedAt ?? null
    };
  }

  refreshToken() {
    return this.#read()?.refreshToken ?? null;
  }

  accessToken() {
    return this.#read()?.accessToken ?? null;
  }

  accessTokenExpiresAt() {
    return this.#read()?.expiresAt ?? null;
  }
}

export const __internal = {FILE_NAME, KEY_FILE_NAME, cleanToken, cleanChannel};

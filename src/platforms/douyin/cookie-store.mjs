import {EncryptedJsonStore} from '../shared/secret-store.mjs';

/**
 * Encrypted local storage for the Douyin login cookie.
 *
 * Only the cookie names the web client actually needs are kept. The file is
 * AES-256-GCM ciphertext in the per-user `secrets/` folder and is excluded from
 * backups. It is never sent anywhere except to Douyin itself.
 *
 * Protection level is stated honestly in `docs/PRIVACY_SECURITY.md`: it protects
 * against another Windows account and accidental leakage, not against a process
 * running as the same user.
 */

const ALLOWED = new Set([
  'sessionid',
  'sessionid_ss',
  'sid_tt',
  'uid_tt',
  'uid_tt_ss',
  'sid_guard',
  'sso_uid_tt',
  'sso_uid_tt_ss',
  'passport_csrf_token',
  'passport_csrf_token_default',
  'ttwid',
  'odin_tt',
  'UIFID',
  'UIFID_TEMP',
  'msToken',
  '__ac_nonce',
  '__ac_signature',
  's_v_web_id',
  'd_ticket',
  'store-region',
  'is_dash_user',
  'passport_auth_mix_state',
  'bd_ticket_guard_client_data',
  'bd_ticket_guard_client_data_v2',
  'bd_ticket_guard_client_web_domain',
  'x-web-secsdk-uid',
  '__security_mc_1_s_sdk_crypt_sdk'
]);

export function parseCookiePairs(header) {
  const pairs = new Map();
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name || !value) continue;
    pairs.set(name, value);
  }
  return pairs;
}

export function sanitizeDouyinCookie(header) {
  const pairs = parseCookiePairs(header);
  const kept = [];
  for (const [name, value] of pairs) {
    if (ALLOWED.has(name)) kept.push(`${name}=${value}`);
  }
  return kept.join('; ');
}

export function hasDouyinSession(cookieHeader) {
  const pairs = parseCookiePairs(cookieHeader);
  const value = pairs.get('sessionid') ?? pairs.get('sessionid_ss');
  return Boolean(value && value.length >= 8);
}

export class DouyinCookieStore {
  constructor({dir, fileName = 'douyin-login.json', store = null}) {
    this.store = store ?? new EncryptedJsonStore({
      dir,
      fileName,
      keyFileName: '.douyin-key'
    });
    this.cache = null;
  }

  load() {
    const saved = this.store.load();
    if (!saved?.data?.cookie || !hasDouyinSession(saved.data.cookie)) return null;
    this.cache = {
      cookie: saved.data.cookie,
      user: saved.data.user ?? null,
      savedAt: saved.savedAt ?? null
    };
    return {...this.cache};
  }

  save({cookie, user = null, now = Date.now()}) {
    const clean = sanitizeDouyinCookie(cookie);
    if (!hasDouyinSession(clean)) {
      throw new Error('refusing to save a Douyin cookie without a session id');
    }
    const result = this.store.save({cookie: clean, user}, {now});
    this.cache = {cookie: clean, user, savedAt: result.savedAt};
    return {user, savedAt: result.savedAt};
  }

  clear() {
    this.cache = null;
    this.store.clear();
    return true;
  }

  /** Safe for HTTP responses: never returns the cookie. */
  status() {
    const value = this.cache ?? this.load();
    return {
      stored: Boolean(value?.cookie),
      user: value?.user ?? null,
      savedAt: value?.savedAt ?? null
    };
  }

  cookie() {
    const value = this.cache ?? this.load();
    return value?.cookie ?? '';
  }
}

export const __internal = {ALLOWED};

import {randomBytes, timingSafeEqual} from 'node:crypto';

/**
 * Local console session authentication.
 *
 * Threat model
 * ------------
 * The HTTP server only listens on 127.0.0.1, but loopback is not an
 * authorization boundary: any process running as the same Windows user (and,
 * with the old requireAdministrator manifest, any process that could reach the
 * elevated listener) could call `/api/*`. A browser on a malicious page is a
 * second, different threat: it has no access to the console's cookie because
 * the cookie is HttpOnly and SameSite=Strict, and the Host/Origin checks in
 * `app.mjs` reject cross-site requests.
 *
 * Design
 * ------
 * - Each server start creates a random, process-local **bootstrap token** and a
 *   random **session token**. Nothing is persisted, so restarting LiveMemory
 *   invalidates every old credential.
 * - The launcher opens the console with the bootstrap token in the URL
 *   **fragment** (`#lm_bootstrap=...`). Fragments are never sent to the server,
 *   never appear in Referer headers and are not stored in the HTTP access path.
 * - The page exchanges the one-time bootstrap token for an HttpOnly,
 *   SameSite=Strict session cookie. The token is consumed immediately; a replay
 *   returns 401.
 * - There is deliberately no endpoint that returns a token. `/api/auth/session`
 *   only accepts a token the caller already possesses, and `/api/auth/status`
 *   only reports whether the caller's cookie is valid.
 *
 * Limits
 * ------
 * This cannot defend against malware running as the same Windows user: such a
 * process can read browser profile data, inject into the browser, or scrape the
 * one-time URL while the browser is being launched. It does raise the bar from
 * "any local process can call every API" to "the process must obtain the
 * short-lived, one-time browser credential". See docs/PRIVACY_SECURITY.md.
 */

export const AUTH_COOKIE = 'lm_session';
export const DEFAULT_BOOTSTRAP_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** API endpoints that must remain reachable without a session. */
export const PUBLIC_API_PATHS = Object.freeze(new Set([
  // Liveness probe used by the single-instance launcher. Contains no user data.
  '/api/health',
  // Exchange of the launcher-provided one-time token.
  '/api/auth/session',
  // Boolean-only session probe; never returns a token or personal data.
  '/api/auth/status'
]));

export function isPublicApiPath(pathname) {
  return PUBLIC_API_PATHS.has(String(pathname ?? ''));
}

/** Parse a Cookie header without throwing on malformed input. */
export function parseCookies(header) {
  const cookies = Object.create(null);
  if (!header) return cookies;
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    cookies[name] = part.slice(separator + 1).trim();
  }
  return cookies;
}

function tokenEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length === 0 || right.length === 0) return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function newToken(randomBytesImpl) {
  return randomBytesImpl(32).toString('base64url');
}

function cookieHeader(token, maxAgeSeconds) {
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

/**
 * @param {{
 *   enabled?: boolean,
 *   now?: () => number,
 *   bootstrapTtlMs?: number,
 *   sessionTtlMs?: number,
 *   randomBytesImpl?: (size: number) => Buffer
 * }} options
 */
export function createAuthService({
  enabled = true,
  now = () => Date.now(),
  bootstrapTtlMs = DEFAULT_BOOTSTRAP_TTL_MS,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  randomBytesImpl = randomBytes
} = {}) {
  const sessionMaxAgeSeconds = Math.max(60, Math.floor(sessionTtlMs / 1000));
  const state = {
    enabled: Boolean(enabled),
    bootstrapToken: null,
    bootstrapExpiresAt: 0,
    bootstrapConsumed: false,
    sessionToken: null,
    sessionExpiresAt: 0
  };

  function resetBootstrap() {
    state.bootstrapToken = state.enabled ? newToken(randomBytesImpl) : null;
    state.bootstrapExpiresAt = state.enabled ? now() + Math.max(1000, bootstrapTtlMs) : 0;
    state.bootstrapConsumed = false;
  }

  function resetSession() {
    state.sessionToken = state.enabled ? newToken(randomBytesImpl) : null;
    state.sessionExpiresAt = state.enabled ? now() + Math.max(1000, sessionTtlMs) : 0;
  }

  if (state.enabled) {
    resetBootstrap();
    resetSession();
  }

  return {
    enabled: state.enabled,
    cookieName: AUTH_COOKIE,
    sessionMaxAgeSeconds,

    /**
     * URL to hand to the default browser. The token lives in the fragment so it
     * is never part of the HTTP request path, logs, or Referer headers.
     */
    browserUrl(baseUrl) {
      const base = String(baseUrl ?? '');
      if (!state.enabled || !state.bootstrapToken) return base;
      return `${base}#lm_bootstrap=${encodeURIComponent(state.bootstrapToken)}`;
    },

    /** Validate the session cookie. Never returns the token itself. */
    authenticate(req) {
      if (!state.enabled) return {ok: true, enabled: false};
      const token = parseCookies(req?.headers?.cookie)[AUTH_COOKIE];
      if (!token) return {ok: false, enabled: true, reason: 'missing'};
      if (!state.sessionToken) return {ok: false, enabled: true, reason: 'invalid'};
      if (now() > state.sessionExpiresAt) return {ok: false, enabled: true, reason: 'expired'};
      if (!tokenEquals(token, state.sessionToken)) return {ok: false, enabled: true, reason: 'invalid'};
      return {ok: true, enabled: true};
    },

    /**
     * Consume the one-time bootstrap token and return a Set-Cookie value.
     * A missing, expired, already consumed or wrong token never creates a
     * session.
     */
    exchange(token) {
      if (!state.enabled) return {ok: false, reason: 'disabled'};
      if (!state.bootstrapToken || state.bootstrapConsumed) return {ok: false, reason: 'used'};
      if (now() > state.bootstrapExpiresAt) return {ok: false, reason: 'expired'};
      if (!tokenEquals(token, state.bootstrapToken)) return {ok: false, reason: 'invalid'};
      // Consume before issuing the session: a replayed URL must not work.
      state.bootstrapConsumed = true;
      state.bootstrapToken = null;
      resetSession();
      return {
        ok: true,
        cookie: cookieHeader(state.sessionToken, sessionMaxAgeSeconds)
      };
    },

    /** Test/diagnostic hook: invalidate all browser sessions immediately. */
    invalidateSessions() {
      state.sessionToken = null;
      state.sessionExpiresAt = 0;
    },

    /** Test/diagnostic hook: expire the bootstrap link immediately. */
    invalidateBootstrap() {
      state.bootstrapToken = null;
      state.bootstrapExpiresAt = 0;
      state.bootstrapConsumed = true;
    },

    /** Introspection without secrets, used by /api/auth/status and diagnostics. */
    status() {
      return {
        enabled: state.enabled,
        bootstrapAvailable: Boolean(state.enabled && !state.bootstrapConsumed && state.bootstrapToken),
        sessionActive: Boolean(state.enabled && state.sessionToken && now() <= state.sessionExpiresAt)
      };
    }
  };
}

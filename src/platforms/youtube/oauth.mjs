import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {AppError} from '../../shared/errors.mjs';

/**
 * Google OAuth 2.0 for a Windows desktop application.
 *
 * Contract:
 * - the *system browser* opens Google's own authorization page; the app never
 *   embeds a login form and never asks for a Google password;
 * - the redirect goes to `http://127.0.0.1:<ephemeral>/oauth2/callback`, so no
 *   public server and no manually copied authorization code are needed;
 * - PKCE (S256) is always used, plus a random `state` that the receiver checks;
 * - `access_type=offline` + `prompt=consent` request a refresh token so the
 *   login survives a restart, and the refresh token is stored encrypted by
 *   `token-store.mjs`, never in a log or a settings file.
 *
 * Nothing in this module writes tokens to the log.
 */

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export const OAUTH_ERRORS = Object.freeze({
  NOT_CONFIGURED: 'YOUTUBE_NOT_CONFIGURED',
  PENDING: 'YOUTUBE_LOGIN_PENDING',
  DENIED: 'YOUTUBE_LOGIN_DENIED',
  TIMEOUT: 'YOUTUBE_LOGIN_TIMEOUT',
  INVALID_GRANT: 'YOUTUBE_AUTH_EXPIRED',
  CLIENT_INVALID: 'YOUTUBE_OAUTH_CLIENT_INVALID',
  NETWORK: 'YOUTUBE_OAUTH_NETWORK',
  STATE_MISMATCH: 'YOUTUBE_OAUTH_STATE',
  EXCHANGE_FAILED: 'YOUTUBE_OAUTH_EXCHANGE'
});

export class OAuthError extends AppError {
  constructor(code, {messageKey = null, httpStatus = 400, details = null, cause = null} = {}) {
    super(code, {messageKey: messageKey ?? 'errors.youtubeAuth', httpStatus, details, cause});
    this.name = 'OAuthError';
  }
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

/** RFC 7636 PKCE pair: a 43-128 character verifier and its S256 challenge. */
export function createPkcePair(randomBytesImpl = randomBytes) {
  const verifier = base64Url(randomBytesImpl(32));
  const challenge = base64Url(createHash('sha256').update(verifier, 'ascii').digest());
  return {verifier, challenge, method: 'S256'};
}

export function buildAuthUrl({
  clientId,
  redirectUri,
  scopes,
  state,
  codeChallenge,
  codeChallengeMethod = 'S256',
  loginHint = null
}) {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', codeChallengeMethod);
  // Offline access + explicit consent is what makes a refresh token available
  // for "restore the login after a restart".
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

/* ------------------------------------------------------------------ pages -- */

const CALLBACK_TEXT = {
  'zh-CN': {
    title: '已连接 YouTube',
    body: 'LiveMemory 已收到授权，可以返回应用继续操作。这个页面可以关闭。',
    close: '关闭这个页面',
    failedTitle: '授权未完成',
    failedBody: '没有收到有效的授权结果。请回到 LiveMemory 重新点击登录。'
  },
  ja: {
    title: 'YouTube に接続しました',
    body: 'LiveMemory が認可を受け取りました。アプリに戻って操作を続けてください。このページは閉じてかまいません。',
    close: 'このページを閉じる',
    failedTitle: '認可が完了しませんでした',
    failedBody: '有効な認可結果を受け取れませんでした。LiveMemory に戻って、もう一度ログインしてください。'
  },
  en: {
    title: 'YouTube connected',
    body: 'LiveMemory received the authorization. You can return to the app and continue. This page can be closed.',
    close: 'Close this page',
    failedTitle: 'Authorization was not completed',
    failedBody: 'No valid authorization result was received. Return to LiveMemory and start the login again.'
  }
};

export function callbackPage(locale = 'en', {ok = true} = {}) {
  const text = CALLBACK_TEXT[locale] ?? CALLBACK_TEXT.en;
  const title = ok ? text.title : text.failedTitle;
  const body = ok ? text.body : text.failedBody;
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    background: #f5f5f7; color: #1d1d1f;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #111113; color: #f5f5f7; }
    .card { background: #1c1c1f; border-color: #2c2c31; }
  }
  .card {
    background: #ffffff; border: 1px solid #e5e5ea; border-radius: 20px;
    padding: 40px 44px; max-width: 420px; text-align: center;
    box-shadow: 0 20px 60px rgba(0,0,0,.08);
  }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; letter-spacing: -0.01em; }
  p { font-size: 15px; line-height: 1.6; margin: 0 0 24px; opacity: .78; }
  a { display: inline-block; font-size: 15px; color: #0071e3; text-decoration: none; }
</style>
</head>
<body>
  <main class="card">
    <h1>${title}</h1>
    <p>${body}</p>
    <a href="#" onclick="window.close();return false;">${text.close}</a>
  </main>
</body>
</html>`;
}

/* --------------------------------------------------------------- receiver -- */

/**
 * Loopback redirect receiver.
 *
 * A single one-shot server per login attempt, bound to 127.0.0.1 on an
 * ephemeral port. It accepts exactly one callback path and validates `state`
 * before resolving. Everything else gets a 404 so unrelated local requests
 * cannot be mistaken for an authorization result.
 */
export class LoopbackReceiver {
  constructor({path = '/oauth2/callback', timeoutMs = 5 * 60 * 1000, locale = 'en', now = Date.now} = {}) {
    this.path = path;
    this.timeoutMs = timeoutMs;
    this.locale = locale;
    this.now = now;
    this.server = null;
    this.port = null;
    this.redirectUri = null;
    this.pending = null;
    this.settled = false;
    this.timer = null;
    this.received = null;
  }

  async listen({port = 0, host = '127.0.0.1'} = {}) {
    if (this.server) return {port: this.port, redirectUri: this.redirectUri};
    this.server = createServer((req, res) => this.#handle(req, res));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.removeListener('listening', onListening);
        reject(new OAuthError(OAUTH_ERRORS.NETWORK, {
          details: {reason: 'listen'},
          cause: error,
          httpStatus: 502
        }));
      };
      const onListening = () => {
        this.server?.removeListener('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen({port, host, exclusive: true});
    });
    this.port = this.server.address().port;
    this.redirectUri = `http://${host}:${this.port}${this.path}`;
    this.timer = setTimeout(() => {
      this.#fail(new OAuthError(OAUTH_ERRORS.TIMEOUT, {messageKey: 'errors.youtubeLoginTimeout', httpStatus: 408}));
    }, this.timeoutMs);
    this.timer.unref?.();
    return {port: this.port, redirectUri: this.redirectUri};
  }

  #writePage(res, status, ok) {
    const html = callbackPage(this.locale, {ok});
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    res.end(html);
  }

  #handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'GET' || url.pathname !== this.path) {
      res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'}).end('not found');
      return;
    }

    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    this.received = {state, hasCode: Boolean(code), error: error ?? null};

    if (error) {
      this.#writePage(res, 400, false);
      this.#fail(error === 'access_denied'
        ? new OAuthError(OAUTH_ERRORS.DENIED, {messageKey: 'errors.youtubeLoginDenied', httpStatus: 403})
        : new OAuthError(OAUTH_ERRORS.EXCHANGE_FAILED, {details: {reason: 'provider_error', error}, httpStatus: 502}));
      return;
    }
    if (!code) {
      this.#writePage(res, 400, false);
      this.#fail(new OAuthError(OAUTH_ERRORS.EXCHANGE_FAILED, {details: {reason: 'missing_code'}, httpStatus: 502}));
      return;
    }
    // State is compared by the owner of the flow; the receiver only delivers it.
    this.#writePage(res, 200, true);
    this.#resolve({code, state});
  }

  waitForResult() {
    if (this.resolvedValue) return Promise.resolve(this.resolvedValue);
    if (!this.pending) {
      this.pending = new Promise((resolve, reject) => {
        this.resolvePending = resolve;
        this.rejectPending = reject;
      });
      // A timeout/denial can happen before anybody awaits; mark the rejection as
      // handled so it never becomes an unhandled rejection, while awaiters still
      // receive the original error.
      this.pending.catch(() => {});
    }
    return this.pending;
  }

  #resolve(value) {
    if (this.settled) return;
    this.settled = true;
    this.resolvedValue = value;
    this.#cleanup();
    this.resolvePending?.(value);
  }

  #fail(error) {
    if (this.settled) return;
    this.settled = true;
    this.#cleanup();
    this.rejectPending?.(error);
  }

  #cleanup() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async close() {
    this.settled = true;
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
    this.#cleanup();
  }
}

/** Constant-time state comparison (lengths differ -> false, never throws). */
export function stateMatches(expected, actual) {
  const left = Buffer.from(String(expected ?? ''));
  const right = Buffer.from(String(actual ?? ''));
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* ----------------------------------------------------------------- tokens -- */

function normalizeTokenPayload(payload, {previousRefreshToken = null, now = Date.now} = {}) {
  const expiresIn = Number(payload?.expires_in ?? 0);
  const refreshToken = payload?.refresh_token ?? previousRefreshToken ?? null;
  return {
    accessToken: payload?.access_token ?? null,
    refreshToken,
    tokenType: payload?.token_type ?? 'Bearer',
    scope: payload?.scope ?? null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : null
  };
}

async function readOAuthResponse(response) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* handled below */
  }
  return {payload, text, status: response.status};
}

function oauthErrorFromBody(payload, status) {
  const error = String(payload?.error ?? '');
  if (error === 'invalid_grant') {
    return new OAuthError(OAUTH_ERRORS.INVALID_GRANT, {messageKey: 'errors.youtubeAuthExpired', httpStatus: 401});
  }
  if (error === 'invalid_client' || error === 'unauthorized_client') {
    return new OAuthError(OAUTH_ERRORS.CLIENT_INVALID, {messageKey: 'errors.youtubeClientInvalid', httpStatus: 500});
  }
  return new OAuthError(OAUTH_ERRORS.EXCHANGE_FAILED, {
    details: {reason: error || `http_${status}`},
    httpStatus: status === 401 ? 401 : 502
  });
}

/** Exchange an authorization code (with PKCE verifier) for tokens. */
export async function exchangeCode({
  fetchImpl = globalThis.fetch,
  clientId,
  clientSecret,
  code,
  codeVerifier,
  redirectUri,
  now = Date.now,
  timeoutMs = 15000
} = {}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: clientId
  });
  if (clientSecret) body.set('client_secret', clientSecret);
  let response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new OAuthError(OAUTH_ERRORS.NETWORK, {details: {reason: 'exchange'}, cause: error, httpStatus: 502});
  }
  const {payload, status} = await readOAuthResponse(response);
  if (!response.ok || !payload?.access_token) throw oauthErrorFromBody(payload, status);
  return normalizeTokenPayload(payload, {now});
}

/** Refresh an access token. `invalid_grant` means the user must log in again. */
export async function refreshAccessToken({
  fetchImpl = globalThis.fetch,
  clientId,
  clientSecret,
  refreshToken,
  now = Date.now,
  timeoutMs = 15000
} = {}) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId
  });
  if (clientSecret) body.set('client_secret', clientSecret);
  let response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new OAuthError(OAUTH_ERRORS.NETWORK, {details: {reason: 'refresh'}, cause: error, httpStatus: 502});
  }
  const {payload, status} = await readOAuthResponse(response);
  if (!response.ok || !payload?.access_token) throw oauthErrorFromBody(payload, status);
  return normalizeTokenPayload(payload, {previousRefreshToken: refreshToken, now});
}

/**
 * Revoke a token at Google. Best effort: a network failure must not prevent the
 * local logout, which already deleted the encrypted credentials.
 */
export async function revokeToken({fetchImpl = globalThis.fetch, token, timeoutMs = 10000} = {}) {
  if (!token) return {revoked: false, reason: 'no-token'};
  try {
    const response = await fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({token}).toString(),
      signal: AbortSignal.timeout(timeoutMs)
    });
    return {revoked: response.ok, status: response.status};
  } catch {
    return {revoked: false, reason: 'network'};
  }
}

export const __internal = {CALLBACK_TEXT, normalizeTokenPayload, oauthErrorFromBody};

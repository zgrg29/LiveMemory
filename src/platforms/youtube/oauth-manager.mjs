import {randomBytes} from 'node:crypto';
import {AppError} from '../../shared/errors.mjs';
import {YouTubeTokenStore} from './token-store.mjs';
import {
  LoopbackReceiver,
  OAUTH_ERRORS,
  OAuthError,
  buildAuthUrl,
  createPkcePair,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  stateMatches
} from './oauth.mjs';
import {YOUTUBE_SCOPES} from './oauth-config.mjs';

/**
 * Sign-in state machine for the streamer's Google account.
 *
 * States: `signed_out` -> `pending` -> `signed_in` | `expired` -> `signed_out`.
 *
 * - The refresh token is persisted encrypted, so the login survives a restart.
 * - The access token is refreshed automatically shortly before it expires.
 * - `invalid_grant` (revoked, or a testing-mode refresh token that expired) moves
 *   the account to `expired`; the UI then offers "sign in again" and the local
 *   credentials can be deleted.
 * - Logout revokes the token at Google (best effort) and always clears local
 *   credentials.
 *
 * Nothing here logs or returns a token.
 */

const EXPIRY_SKEW_MS = 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export const LOGIN_STATE = Object.freeze({
  SIGNED_OUT: 'signed_out',
  PENDING: 'pending',
  SIGNED_IN: 'signed_in',
  EXPIRED: 'expired'
});

export class YouTubeOAuthManager {
  constructor({
    secretsDir,
    client,
    logger = null,
    now = Date.now,
    fetchImpl = globalThis.fetch,
    store = null,
    receiverFactory = null,
    onSignedIn = null
  } = {}) {
    this.client = client ?? {configured: false, clientId: '', clientSecret: '', source: 'none'};
    this.logger = logger;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.store = store ?? new YouTubeTokenStore({dir: secretsDir});
    this.receiverFactory = receiverFactory ?? ((locale) => new LoopbackReceiver({locale, timeoutMs: LOGIN_TIMEOUT_MS, now}));
    this.onSignedIn = onSignedIn;
    this.pending = null;
    this.refreshPromise = null;
    this.lastError = null;
    this.state = this.store.status().stored ? LOGIN_STATE.SIGNED_IN : LOGIN_STATE.SIGNED_OUT;
  }

  get configured() {
    return Boolean(this.client?.configured);
  }

  status() {
    const stored = this.store.status();
    return {
      configured: this.configured,
      state: this.state,
      signedIn: this.state === LOGIN_STATE.SIGNED_IN,
      pending: Boolean(this.pending),
      channel: stored.channel ?? null,
      hasRefreshToken: stored.hasRefreshToken,
      expiresAt: stored.expiresAt,
      savedAt: stored.savedAt,
      scopes: [...YOUTUBE_SCOPES],
      lastError: this.lastError ? {code: this.lastError.code, messageKey: this.lastError.messageKey} : null
    };
  }

  #requireConfigured() {
    if (this.configured) return;
    throw new OAuthError(OAUTH_ERRORS.NOT_CONFIGURED, {
      messageKey: 'errors.youtubeNotConfigured',
      httpStatus: 409
    });
  }

  /**
   * Begin the installed-app flow: start the loopback receiver, build the Google
   * authorization URL and return it so the UI can open the system browser.
   */
  async startLogin({locale = 'en'} = {}) {
    this.#requireConfigured();
    if (this.pending) {
      return {authUrl: this.pending.authUrl, expiresAt: this.pending.expiresAt, reused: true};
    }
    const receiver = this.receiverFactory(locale);
    const {redirectUri} = await receiver.listen();
    const pkce = createPkcePair();
    const state = randomBytes(16).toString('hex');
    const authUrl = buildAuthUrl({
      clientId: this.client.clientId,
      redirectUri,
      scopes: YOUTUBE_SCOPES,
      state,
      codeChallenge: pkce.challenge
    });
    const expiresAt = this.now() + LOGIN_TIMEOUT_MS;
    this.pending = {
      receiver,
      verifier: pkce.verifier,
      state,
      redirectUri,
      authUrl,
      expiresAt,
      promise: null
    };
    this.state = LOGIN_STATE.PENDING;
    this.lastError = null;
    this.pending.promise = this.#completeLogin(this.pending);
    this.completion = this.pending.promise;
    this.logger?.info({event: 'youtube.login.started'});
    return {authUrl, expiresAt, reused: false};
  }

  async #completeLogin(pending) {
    try {
      const result = await pending.receiver.waitForResult();
      if (!stateMatches(pending.state, result.state)) {
        throw new OAuthError(OAUTH_ERRORS.STATE_MISMATCH, {
          messageKey: 'errors.youtubeLoginFailed',
          httpStatus: 400
        });
      }
      const tokens = await exchangeCode({
        fetchImpl: this.fetchImpl,
        clientId: this.client.clientId,
        clientSecret: this.client.clientSecret,
        code: result.code,
        codeVerifier: pending.verifier,
        redirectUri: pending.redirectUri,
        now: this.now
      });
      if (!tokens.refreshToken) {
        // Without a refresh token the login would die on restart; a consented
        // `access_type=offline` request should always return one.
        this.logger?.warn({event: 'youtube.login.no_refresh_token'});
      }
      this.store.saveTokens(tokens, {now: this.now()});
      this.state = LOGIN_STATE.SIGNED_IN;
      this.lastError = null;
      await this.#afterSignIn();
      this.logger?.info({event: 'youtube.login.completed'});
      return {ok: true};
    } catch (error) {
      this.state = this.store.status().stored ? LOGIN_STATE.SIGNED_IN : LOGIN_STATE.SIGNED_OUT;
      this.lastError = error;
      this.logger?.warn({event: 'youtube.login.failed', code: error?.code ?? 'unknown'});
      return {ok: false, error};
    } finally {
      this.pending = null;
      try {
        await pending.receiver.close();
      } catch {
        /* ignore */
      }
    }
  }

  async #afterSignIn() {
    if (typeof this.onSignedIn !== 'function') return;
    try {
      await this.onSignedIn(this);
    } catch (error) {
      // Not being able to read the channel title is not a login failure.
      this.logger?.debug?.({event: 'youtube.profile.failed', code: error?.code ?? 'unknown'});
    }
  }

  setChannel(channel) {
    return this.store.setChannel(channel);
  }

  /** Wait for the flow that is already running (used by tests/diagnostics). */
  async waitForLogin() {
    if (this.completion) return this.completion;
    return {ok: this.state === LOGIN_STATE.SIGNED_IN};
  }

  async #refresh() {
    const refreshToken = this.store.refreshToken();
    if (!refreshToken) {
      this.state = LOGIN_STATE.EXPIRED;
      throw new OAuthError(OAUTH_ERRORS.INVALID_GRANT, {
        messageKey: 'errors.youtubeAuthExpired',
        httpStatus: 401
      });
    }
    try {
      const tokens = await refreshAccessToken({
        fetchImpl: this.fetchImpl,
        clientId: this.client.clientId,
        clientSecret: this.client.clientSecret,
        refreshToken,
        now: this.now
      });
      this.store.saveTokens(tokens, {now: this.now()});
      this.state = LOGIN_STATE.SIGNED_IN;
      this.lastError = null;
      return tokens.accessToken;
    } catch (error) {
      if (error?.code === OAUTH_ERRORS.INVALID_GRANT) {
        this.state = LOGIN_STATE.EXPIRED;
      }
      this.lastError = error;
      throw error;
    }
  }

  /**
   * Valid access token, refreshed on demand. Concurrent callers share one
   * refresh request so a burst of polls cannot stampede the token endpoint.
   */
  async getAccessToken({force = false} = {}) {
    if (!this.configured) this.#requireConfigured();
    const token = this.store.accessToken();
    const expiresAt = this.store.accessTokenExpiresAt();
    const valid = token && (expiresAt === null || expiresAt - this.now() > EXPIRY_SKEW_MS);
    if (valid && !force) return token;
    if (!this.refreshPromise) {
      this.refreshPromise = this.#refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  /** Called by the adapter after an authenticated request was rejected. */
  async handleAuthFailure() {
    try {
      await this.getAccessToken({force: true});
      return true;
    } catch {
      return false;
    }
  }

  async logout({revoke = true} = {}) {
    const token = this.store.refreshToken() ?? this.store.accessToken();
    if (this.pending) {
      try {
        await this.pending.receiver.close();
      } catch {
        /* ignore */
      }
      this.pending = null;
    }
    this.store.clear();
    this.state = LOGIN_STATE.SIGNED_OUT;
    this.lastError = null;
    if (revoke && token) {
      const result = await revokeToken({fetchImpl: this.fetchImpl, token});
      this.logger?.info({event: 'youtube.logout', revoked: result.revoked});
      return {revoked: result.revoked};
    }
    this.logger?.info({event: 'youtube.logout', revoked: false});
    return {revoked: false};
  }
}

export function requireSignedIn(manager) {
  if (!manager?.status().signedIn) {
    throw new AppError('YOUTUBE_AUTH_REQUIRED', {messageKey: 'errors.youtubeAuthRequired', httpStatus: 401});
  }
}

export const __internal = {EXPIRY_SKEW_MS, LOGIN_TIMEOUT_MS};

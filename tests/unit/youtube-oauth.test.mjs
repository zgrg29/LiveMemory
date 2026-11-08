import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  LoopbackReceiver,
  OAuthError,
  OAUTH_ERRORS,
  buildAuthUrl,
  callbackPage,
  createPkcePair,
  exchangeCode,
  refreshAccessToken,
  stateMatches
} from '../../src/platforms/youtube/oauth.mjs';
import {YouTubeOAuthManager, LOGIN_STATE} from '../../src/platforms/youtube/oauth-manager.mjs';
import {YouTubeTokenStore} from '../../src/platforms/youtube/token-store.mjs';

const CLIENT = {
  configured: true,
  clientId: '1234567890-abc.apps.googleusercontent.com',
  clientSecret: 'installed-app-secret',
  source: 'bundled'
};

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'lm-yt-'));
}

test('PKCE challenge is the base64url SHA-256 of the verifier', async () => {
  const pair = createPkcePair();
  assert.equal(pair.method, 'S256');
  assert.ok(pair.verifier.length >= 43 && pair.verifier.length <= 128);
  const expected = createHash('sha256').update(pair.verifier, 'ascii').digest('base64url');
  assert.equal(pair.challenge, expected);
});

test('the authorization URL carries every required installed-app parameter', () => {
  const url = new URL(buildAuthUrl({
    clientId: CLIENT.clientId,
    redirectUri: 'http://127.0.0.1:53211/oauth2/callback',
    scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
    state: 'state-123',
    codeChallenge: 'challenge'
  }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:53211/oauth2/callback');
  assert.match(url.searchParams.get('scope'), /youtube\.readonly/);
});

test('state comparison is length safe', () => {
  assert.equal(stateMatches('abc', 'abc'), true);
  assert.equal(stateMatches('abc', 'abd'), false);
  assert.equal(stateMatches('abc', 'abcd'), false);
  assert.equal(stateMatches('', ''), false);
  assert.equal(stateMatches(undefined, 'abc'), false);
});

test('the callback page is local, static and localized', () => {
  for (const locale of ['zh-CN', 'ja', 'en']) {
    const html = callbackPage(locale, {ok: true});
    assert.match(html, /<!doctype html>/i);
    assert.ok(!/https?:\/\//.test(html.replace(/<html lang="[^"]*">/, '')), 'no external resources');
  }
  assert.match(callbackPage('en', {ok: false}), /Authorization was not completed/);
});

test('the loopback receiver only accepts its own callback path and delivers code+state', async () => {
  const receiver = new LoopbackReceiver({locale: 'en'});
  const {redirectUri} = await receiver.listen();
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/);

  const notFound = await fetch(redirectUri.replace('/oauth2/callback', '/other'));
  assert.equal(notFound.status, 404);

  const result = receiver.waitForResult();
  const ok = await fetch(`${redirectUri}?code=auth-code&state=state-value`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /YouTube connected/);
  assert.deepEqual(await result, {code: 'auth-code', state: 'state-value'});
  await receiver.close();
});

test('a denied authorization rejects with a translatable error', async () => {
  const receiver = new LoopbackReceiver({locale: 'en'});
  const {redirectUri} = await receiver.listen();
  const result = receiver.waitForResult();
  const response = await fetch(`${redirectUri}?error=access_denied&state=abc`);
  assert.equal(response.status, 400);
  await assert.rejects(() => result, (error) => {
    assert.ok(error instanceof OAuthError);
    assert.equal(error.code, OAUTH_ERRORS.DENIED);
    assert.equal(error.messageKey, 'errors.youtubeLoginDenied');
    return true;
  });
  await receiver.close();
});

test('the code exchange and refresh map Google errors to stable codes', async () => {
  const success = async (url, init) => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('code_verifier'), 'verifier');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's'})
    };
  };
  const tokens = await exchangeCode({
    fetchImpl: success,
    clientId: CLIENT.clientId,
    clientSecret: CLIENT.clientSecret,
    code: 'code',
    codeVerifier: 'verifier',
    redirectUri: 'http://127.0.0.1:1/cb',
    now: () => 1000
  });
  assert.equal(tokens.accessToken, 'at');
  assert.equal(tokens.refreshToken, 'rt');
  assert.equal(tokens.expiresAt, 1000 + 3600 * 1000);

  const invalid = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({error: 'invalid_grant'})
  });
  await assert.rejects(() => exchangeCode({
    fetchImpl: invalid,
    clientId: CLIENT.clientId,
    code: 'c',
    codeVerifier: 'v',
    redirectUri: 'http://127.0.0.1:1/cb'
  }), (error) => error.code === OAUTH_ERRORS.INVALID_GRANT);

  await assert.rejects(() => refreshAccessToken({
    fetchImpl: invalid,
    clientId: CLIENT.clientId,
    clientSecret: CLIENT.clientSecret,
    refreshToken: 'rt'
  }), (error) => error.code === OAUTH_ERRORS.INVALID_GRANT);
});

test('a refresh keeps the previous refresh token when Google omits it', async () => {
  const tokens = await refreshAccessToken({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({access_token: 'new-at', expires_in: 3600})
    }),
    clientId: CLIENT.clientId,
    clientSecret: CLIENT.clientSecret,
    refreshToken: 'old-rt',
    now: () => 500
  });
  assert.equal(tokens.refreshToken, 'old-rt');
  assert.equal(tokens.accessToken, 'new-at');
});

test('the login state machine completes the loopback flow and restores after restart', async () => {
  const dir = tempDir();
  try {
    const fetchImpl = async (url, init = {}) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        const body = new URLSearchParams(init.body);
        assert.equal(body.get('grant_type'), 'authorization_code');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/youtube.readonly'
          })
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const manager = new YouTubeOAuthManager({
      secretsDir: dir,
      client: CLIENT,
      fetchImpl,
      now: () => 10_000
    });
    assert.equal(manager.status().state, LOGIN_STATE.SIGNED_OUT);

    const started = await manager.startLogin({locale: 'en'});
    const authUrl = new URL(started.authUrl);
    const redirectUri = authUrl.searchParams.get('redirect_uri');
    const state = authUrl.searchParams.get('state');
    assert.ok(redirectUri.startsWith('http://127.0.0.1:'));

    // Simulate the browser returning from Google.
    const callback = await fetch(`${redirectUri}?code=the-code&state=${state}`);
    assert.equal(callback.status, 200);
    const completion = await manager.waitForLogin();
    assert.equal(completion.ok, true);
    assert.equal(manager.status().signedIn, true);
    assert.equal(await manager.getAccessToken(), 'access-1');

    // "Restart": a new manager on the same directory restores the login.
    const restarted = new YouTubeOAuthManager({secretsDir: dir, client: CLIENT, fetchImpl, now: () => 10_000});
    assert.equal(restarted.status().signedIn, true);
    assert.equal(restarted.status().hasRefreshToken, true);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a completed flow with a mismatched state is rejected', async () => {
  const dir = tempDir();
  try {
    const manager = new YouTubeOAuthManager({
      secretsDir: dir,
      client: CLIENT,
      fetchImpl: async () => {
        throw new Error('must not exchange');
      },
      now: () => 1
    });
    const started = await manager.startLogin({locale: 'en'});
    const redirectUri = new URL(started.authUrl).searchParams.get('redirect_uri');
    await fetch(`${redirectUri}?code=c&state=wrong-state`);
    const completion = await manager.waitForLogin();
    assert.equal(completion.ok, false);
    assert.equal(completion.error.code, OAUTH_ERRORS.STATE_MISMATCH);
    assert.equal(manager.status().signedIn, false);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('login refuses to start when the maintainer has not configured a client', async () => {
  const dir = tempDir();
  try {
    const manager = new YouTubeOAuthManager({
      secretsDir: dir,
      client: {configured: false, clientId: '', clientSecret: '', source: 'none'}
    });
    await assert.rejects(() => manager.startLogin(), (error) => {
      assert.equal(error.code, OAUTH_ERRORS.NOT_CONFIGURED);
      assert.equal(error.messageKey, 'errors.youtubeNotConfigured');
      return true;
    });
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('an expired refresh token moves the account to expired, not silently signed out', async () => {
  const dir = tempDir();
  try {
    const store = new YouTubeTokenStore({dir});
    store.saveTokens({accessToken: 'old', refreshToken: 'dead', expiresAt: 1}, {now: 1});
    const manager = new YouTubeOAuthManager({
      secretsDir: dir,
      client: CLIENT,
      now: () => 100_000,
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({error: 'invalid_grant'})
      })
    });
    assert.equal(manager.status().signedIn, true);
    await assert.rejects(() => manager.getAccessToken(), (error) => error.code === OAUTH_ERRORS.INVALID_GRANT);
    assert.equal(manager.status().state, LOGIN_STATE.EXPIRED);
    // The channel/identity is kept so the UI can explain what expired.
    await assert.rejects(() => manager.getAccessToken());
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

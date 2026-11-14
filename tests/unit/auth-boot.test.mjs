import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  clearBootstrapToken,
  establishSession,
  readBootstrapToken
} from '../../src/web/js/auth.js';

function installWindow({hash = '', pathname = '/', search = ''} = {}) {
  const previous = globalThis.window;
  const replaced = [];
  globalThis.window = {
    location: {hash, pathname, search},
    history: {
      replaceState(_state, _title, url) {
        replaced.push(url);
        const index = url.indexOf('#');
        globalThis.window.location.hash = index >= 0 ? url.slice(index) : '';
      }
    }
  };
  return {
    replaced,
    restore() {
      globalThis.window = previous;
    }
  };
}

test('the bootstrap token is read only from the URL fragment', (t) => {
  const env = installWindow({hash: '#lm_bootstrap=abc123'});
  t.after(() => env.restore());
  assert.equal(readBootstrapToken(), 'abc123');
  globalThis.window.location.hash = '#/live';
  assert.equal(readBootstrapToken(), null);
  globalThis.window.location.hash = '#/history?q=x&lm_bootstrap=token2';
  assert.equal(readBootstrapToken(), 'token2');
  globalThis.window.location.hash = '';
  assert.equal(readBootstrapToken(), null);
});

test('clearing the token preserves the route and other fragment parameters', (t) => {
  const env = installWindow({hash: '#/history?q=x&lm_bootstrap=abc123'});
  t.after(() => env.restore());
  clearBootstrapToken();
  assert.deepEqual(env.replaced, ['/#/history?q=x']);
});

test('clearing a token on the default route falls back to the live page', (t) => {
  const env = installWindow({hash: '#lm_bootstrap=abc123'});
  t.after(() => env.restore());
  clearBootstrapToken();
  assert.deepEqual(env.replaced, ['/#/live']);
});

test('establishSession exchanges a fragment token and clears it', async (t) => {
  const env = installWindow({hash: '#lm_bootstrap=one-time'});
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url, options});
    return {ok: true};
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    env.restore();
  });
  const result = await establishSession();
  assert.deepEqual(result, {ok: true});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/auth/session');
  assert.deepEqual(JSON.parse(calls[0].options.body), {token: 'one-time'});
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(globalThis.window.location.hash, '#/live');
});

test('establishSession reports missing, invalid and network sessions distinctly', async (t) => {
  const env = installWindow({hash: ''});
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    env.restore();
  });

  globalThis.fetch = async () => ({ok: true, json: async () => ({authenticated: false})});
  assert.deepEqual(await establishSession(), {ok: false, code: 'AUTH_REQUIRED'});

  globalThis.fetch = async () => ({ok: true, json: async () => ({authenticated: true})});
  assert.deepEqual(await establishSession(), {ok: true});

  globalThis.fetch = async () => ({ok: false, json: async () => ({})});
  assert.deepEqual(await establishSession(), {ok: false, code: 'NETWORK'});

  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  assert.deepEqual(await establishSession(), {ok: false, code: 'NETWORK'});
});

test('the console boot flow establishes the session before loading any data', () => {
  const app = readFileSync(join(process.cwd(), 'src', 'web', 'js', 'app.js'), 'utf8');
  const auth = readFileSync(join(process.cwd(), 'src', 'web', 'js', 'auth.js'), 'utf8');
  const api = readFileSync(join(process.cwd(), 'src', 'web', 'js', 'api.js'), 'utf8');
  assert.match(app, /import \{establishSession\} from '\.\/auth\.js'/);
  assert.match(app, /const auth = await establishSession\(\)/);
  assert.match(app, /if \(!auth\.ok\)/);
  assert.match(app, /api\.get\('\/api\/bootstrap'\)/);
  assert.match(app, /lm:auth-required/);
  assert.match(api, /response\.status === 401/);
  assert.match(api, /lm:auth-required/);
  assert.doesNotMatch(auth, /window\.localStorage|localStorage\.(?:get|set|remove)Item/);
  assert.doesNotMatch(auth, /window\.sessionStorage|sessionStorage\.(?:get|set|remove)Item/);
  assert.doesNotMatch(auth, /console\.log/);
});

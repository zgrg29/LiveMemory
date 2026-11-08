import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {YouTubeTokenStore} from '../../src/platforms/youtube/token-store.mjs';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-yt-token-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

const TOKENS = {
  accessToken: 'ya29.access-secret-value',
  refreshToken: '1//refresh-secret-value',
  expiresAt: 1_700_003_600_000,
  scope: 'https://www.googleapis.com/auth/youtube.readonly',
  tokenType: 'Bearer'
};

test('tokens round-trip through the encrypted store', () => {
  withTempDir((dir) => {
    const store = new YouTubeTokenStore({dir});
    store.saveTokens(TOKENS, {now: 1_700_000_000_000});
    assert.equal(store.refreshToken(), TOKENS.refreshToken);
    assert.equal(store.accessToken(), TOKENS.accessToken);
    assert.equal(store.accessTokenExpiresAt(), TOKENS.expiresAt);

    const reloaded = new YouTubeTokenStore({dir});
    assert.equal(reloaded.load().refreshToken, TOKENS.refreshToken);
  });
});

test('the credential file never contains a plaintext token', () => {
  withTempDir((dir) => {
    const store = new YouTubeTokenStore({dir});
    store.saveTokens(TOKENS);
    const raw = readFileSync(join(dir, 'youtube-oauth.json'), 'utf8');
    assert.ok(!raw.includes('refresh-secret-value'));
    assert.ok(!raw.includes('access-secret-value'));
    assert.ok(existsSync(join(dir, '.youtube-oauth-key')));
  });
});

test('status never exposes a token', () => {
  withTempDir((dir) => {
    const store = new YouTubeTokenStore({dir});
    store.saveTokens(TOKENS);
    const status = store.status();
    assert.deepEqual(Object.keys(status).sort(), ['channel', 'expiresAt', 'hasRefreshToken', 'savedAt', 'stored'].sort());
    const serialized = JSON.stringify(status);
    assert.ok(!serialized.includes('secret-value'));
  });
});

test('the channel profile is stored without touching the tokens', () => {
  withTempDir((dir) => {
    const store = new YouTubeTokenStore({dir});
    store.saveTokens(TOKENS);
    store.setChannel({id: 'UC_CHANNEL', title: 'My Channel'});
    const reloaded = new YouTubeTokenStore({dir});
    assert.deepEqual(reloaded.status().channel, {id: 'UC_CHANNEL', title: 'My Channel'});
    assert.equal(reloaded.refreshToken(), TOKENS.refreshToken);
  });
});

test('saving an empty credential is refused', () => {
  withTempDir((dir) => {
    const store = new YouTubeTokenStore({dir});
    assert.throws(() => store.saveTokens({accessToken: '', refreshToken: ''}), /empty YouTube credential/);
  });
});

test('a tampered ciphertext is rejected instead of yielding garbage', () => {
  withTempDir((dir) => {
    const store = new YouTubeTokenStore({dir});
    store.saveTokens(TOKENS);
    const file = join(dir, 'youtube-oauth.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.payload = `${raw.payload.slice(0, -4)}AAAA`;
    writeFileSync(file, JSON.stringify(raw));
    const reloaded = new YouTubeTokenStore({dir});
    assert.equal(reloaded.load(), null);
    assert.equal(reloaded.status().stored, false);
  });
});

test('logout deletes the encrypted file', () => {
  withTempDir((dir) => {
    const store = new YouTubeTokenStore({dir});
    store.saveTokens(TOKENS);
    store.clear();
    assert.equal(store.status().stored, false);
    assert.equal(new YouTubeTokenStore({dir}).status().stored, false);
  });
});

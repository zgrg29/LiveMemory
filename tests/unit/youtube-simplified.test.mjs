import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function read(path) {
  return readFile(join(root, path), 'utf8');
}

test('the official YouTube Data API, OAuth and API-key modules are gone', async () => {
  const files = await readdir(join(root, 'src/platforms/youtube'));
  for (const removed of ['adapter.mjs', 'api.mjs', 'oauth.mjs', 'oauth-manager.mjs', 'oauth-config.mjs', 'token-store.mjs']) {
    assert.equal(files.includes(removed), false, `${removed} must not exist`);
  }
  assert.ok(files.includes('errors.mjs'));
  assert.ok(files.includes('link.mjs'));
  assert.ok(files.includes('mapper.mjs'));
  assert.ok(files.includes('service.mjs'));
});

test('the live console has one YouTube path and no mode/login/quota UI', async () => {
  const source = await read('src/web/js/pages/live.js');
  assert.doesNotMatch(source, /youtubeCaptureMode/);
  assert.doesNotMatch(source, /\/api\/youtube\/login/);
  assert.doesNotMatch(source, /youtubeMode|youtubeLogin|youtubeQuota|youtubeExperimental|officialConfigured|captureMode/);
  assert.match(source, /\/api\/youtube\/video/);
  assert.match(source, /\/api\/youtube\/connect/);
});

test('settings exposes no YouTube mode selector', async () => {
  const source = await read('src/web/js/pages/settings.js');
  assert.doesNotMatch(source, /youtubeCaptureMode/);
  assert.doesNotMatch(source, /youtube-capture-mode/);
  assert.match(source, /settings\.youtube\.privacyBody/);
});

test('routes no longer expose Google login endpoints or mode parameters', async () => {
  const source = await read('src/server/routes.mjs');
  assert.doesNotMatch(source, /\/api\/youtube\/login/);
  assert.doesNotMatch(source, /captureMode/);
  assert.doesNotMatch(source, /oauthConfigured/);
});

test('all three dictionaries contain only the simplified YouTube strings', async () => {
  for (const locale of ['zh-CN', 'ja', 'en']) {
    const dict = JSON.parse(await read(`src/web/i18n/${locale}.json`));
    const sourceKeys = Object.keys(dict.live.source).filter((key) => key.startsWith('youtube'));
    for (const obsolete of [
      'youtubeModeOfficial',
      'youtubeModeAnonymousHint',
      'youtubeCaptureModeTitle',
      'youtubeLoginButton',
      'youtubeQuota',
      'youtubeExperimentalBadge',
      'youtubeAnonymousStats'
    ]) {
      assert.equal(sourceKeys.includes(obsolete), false, `${locale}.${obsolete}`);
    }
    for (const required of ['youtubeTab', 'youtubeIntro', 'youtubeIdentityNote', 'youtubePolicyBody', 'youtubeUnavailable']) {
      assert.equal(sourceKeys.includes(required), true, `${locale}.${required}`);
    }
    assert.deepEqual(Object.keys(dict.settings.youtube).sort(), [
      'dataPolicy',
      'desc',
      'notRequired',
      'privacyBody',
      'privacyTitle',
      'requires',
      'retention',
      'title'
    ]);
  }
});

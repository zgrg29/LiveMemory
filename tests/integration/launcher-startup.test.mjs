import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync, readdirSync, readFileSync, existsSync} from 'node:fs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {runLauncher} from '../../src/launcher/launcher.mjs';
import {writeDataLocation} from '../../src/shared/data-location.mjs';

/**
 * The Windows failure these tests protect against: a normal account cannot use
 * the data folder, the launcher used to escape its error handling (raw EPERM
 * stack) and the console closed before anything could be read. Every failure
 * must now produce a localised message, a log file, and exit code 1.
 */

function captureStream() {
  const chunks = [];
  return {
    isTTY: false,
    chunks,
    write(value) {
      chunks.push(String(value));
      return true;
    },
    text() {
      return chunks.join('');
    }
  };
}

function nonInteractiveStdin() {
  return {
    isTTY: false,
    resume() {},
    pause() {},
    once() {},
    removeListener() {}
  };
}

async function launch(argv, env) {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runLauncher({
    argv,
    env,
    stdout,
    stderr,
    stdin: nonInteractiveStdin(),
    openBrowser: () => ({opened: false}),
    registerProcessHandlers: false,
    fetchImpl: async () => {
      throw new Error('network must not be used by these tests');
    }
  });
  return {code, output: `${stdout.text()}${stderr.text()}`, stdout, stderr};
}

test('an unwritable data folder is reported, logged, and never crashes with a raw stack', async () => {
  const temp = createTempDir();
  const logDir = join(temp.dir, 'logs');
  const blocker = join(temp.dir, 'not-a-folder');
  writeFileSync(blocker, 'x');

  const {code, output} = await launch([
    '--no-open', '--no-wait', '--lang', 'en', '--data-dir', blocker
  ], {LIVE_MEMORY_LOG_DIR: logDir});
  assert.equal(code, 1);
  assert.match(output, /LiveMemory could not start/);
  assert.match(output, /not writable/i);
  assert.match(output, /Failed step: data-dir/);
  assert.doesNotMatch(output, /at Module\./);

  const logs = readdirSync(logDir);
  const startup = logs.find((name) => name.startsWith('startup-'));
  assert.ok(startup, 'expected a startup log');
  const content = readFileSync(join(logDir, startup), 'utf8');
  assert.match(content, /"step":"startup.begin"/);
  assert.match(content, /"step":"data-dir"/);
  assert.match(content, /"ok":false/);
  const report = join(logDir, 'startup-error.json');
  assert.ok(existsSync(report), 'expected a machine readable failure report');
  temp.cleanup();
});

test('the failure message is localised in Chinese and Japanese', async () => {
  const temp = createTempDir();
  const blocker = join(temp.dir, 'file');
  writeFileSync(blocker, 'x');
  const zh = await launch(['--no-open', '--no-wait', '--lang', 'zh-CN', '--data-dir', blocker], {
    LIVE_MEMORY_LOG_DIR: join(temp.dir, 'logs-zh')
  });
  assert.equal(zh.code, 1);
  assert.match(zh.output, /无法启动/);
  assert.match(zh.output, /失败步骤/);

  const ja = await launch(['--no-open', '--no-wait', '--lang', 'ja', '--data-dir', blocker], {
    LIVE_MEMORY_LOG_DIR: join(temp.dir, 'logs-ja')
  });
  assert.equal(ja.code, 1);
  assert.match(ja.output, /起動できません/);
  assert.match(ja.output, /失敗した手順/);
  temp.cleanup();
});

test('an unavailable saved data folder is a hard error, never a new empty database', async () => {
  const temp = createTempDir();
  const missing = join(temp.dir, 'external-drive', 'data');
  const env = {
    LOCALAPPDATA: join(temp.dir, 'local'),
    APPDATA: join(temp.dir, 'roaming'),
    LIVE_MEMORY_LOCATION_DIR: join(temp.dir, 'location'),
    LIVE_MEMORY_LOG_DIR: join(temp.dir, 'logs')
  };
  writeDataLocation(missing, {env});

  const {code, output} = await launch(['--no-open', '--no-wait', '--lang', 'en'], env);
  assert.equal(code, 1);
  assert.match(output, /saved data folder is currently unavailable/i);
  assert.match(output, /Startup location record/);
  assert.match(output, /--data-dir/);
  // The launcher must not create the missing folder or a default database.
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(join(temp.dir, 'local', 'LiveMemory', 'database')), false);
  temp.cleanup();
});

test('--diagnose reports the write probe result and exits non-zero when nothing is writable', async () => {
  const temp = createTempDir();
  const blocker = join(temp.dir, 'file');
  writeFileSync(blocker, 'x');
  const {code, output} = await launch(['--diagnose', '--lang', 'en', '--data-dir', blocker], {
    LIVE_MEMORY_LOG_DIR: join(temp.dir, 'logs')
  });
  assert.equal(code, 1);
  assert.match(output, /Startup environment diagnostics/);
  assert.match(output, /not writable/);
  temp.cleanup();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {parseArguments, __internal} from '../../src/launcher/launcher.mjs';

test('default launch opens the browser and waits on errors', () => {
  const options = parseArguments([]);
  assert.equal(options.open, true);
  assert.equal(options.port, null);
  assert.equal(options.dataDir, null);
  assert.equal(options.lang, null);
  assert.equal(options.waitOnError, true);
});

test('parses the documented flags and their inline form', () => {
  const options = parseArguments(['--no-open', '--no-wait', '--port=48300', '--data-dir', 'D:/tmp/lm', '--lang', 'ja']);
  assert.equal(options.open, false);
  assert.equal(options.waitOnError, false);
  assert.equal(options.port, 48300);
  assert.equal(options.dataDir, 'D:/tmp/lm');
  assert.equal(options.lang, 'ja');
});

test('rejects invalid ports and languages instead of guessing', () => {
  assert.throws(() => parseArguments(['--port', 'abc']), /INVALID_ARGUMENT/);
  assert.throws(() => parseArguments(['--port', '70000']), /INVALID_ARGUMENT/);
  assert.throws(() => parseArguments(['--lang', 'fr']), /INVALID_ARGUMENT/);
  assert.throws(() => parseArguments(['--lang', 'system']), /INVALID_ARGUMENT/);
  assert.throws(() => parseArguments(['--data-dir']), /INVALID_ARGUMENT/);
});

test('keeps unknown flags for diagnostics without failing', () => {
  const options = parseArguments(['--wat', '--help']);
  assert.deepEqual(options.unknown, ['--wat']);
  assert.equal(options.help, true);
});

test('launcher status line reflects recording state', () => {
  const idle = __internal.statusLineText({connection: 'idle', activeSession: null}, 'en');
  assert.match(idle, /Idle/);
  const live = __internal.statusLineText({
    connection: 'connected',
    activeSession: {id: 'ses_1', roomTitle: 'Late night', messageCount: 12, uniqueViewerCount: 3}
  }, 'en');
  assert.match(live, /Late night/);
  assert.match(live, /12/);
  const ja = __internal.statusLineText({connection: 'connecting', activeSession: null}, 'ja');
  assert.match(ja, /接続/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {pauseForUser, isInteractive, showErrorDialog} from '../../src/launcher/diagnostics.mjs';

function fakeStdin({tty = false} = {}) {
  const stdin = new EventEmitter();
  stdin.isTTY = tty;
  stdin.resume = () => {};
  stdin.pause = () => {};
  return stdin;
}

test('an interactive console waits for a key so the error can be read', async () => {
  const stdin = fakeStdin({tty: true});
  const written = [];
  const pending = pauseForUser({stdin, stdout: {write: (value) => written.push(String(value))}, enabled: true, prompt: 'Press any key'});
  assert.equal(isInteractive({stdin}), true);
  stdin.emit('data', Buffer.from('\r'));
  assert.equal(await pending, true);
  assert.match(written.join(''), /Press any key/);
});

test('a redirected or automated run is never blocked', async () => {
  const stdin = fakeStdin({tty: false});
  assert.equal(await pauseForUser({stdin, stdout: {write() {}}, enabled: true}), false);
});

test('--no-wait skips the prompt even on a console', async () => {
  const stdin = fakeStdin({tty: true});
  assert.equal(await pauseForUser({stdin, stdout: {write() {}}, enabled: false}), false);
});

test('the dialog fallback can be disabled without spawning anything', async () => {
  const result = await showErrorDialog({text: 'x', env: {LIVE_MEMORY_ERROR_DIALOG: '0'}});
  assert.equal(result.shown, false);
  assert.equal(result.reason, 'disabled');
});

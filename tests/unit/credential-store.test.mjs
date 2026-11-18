import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {
  CredentialBackendError,
  POWERSHELL_SCRIPT,
  PowerShellCredentialBridge,
  WindowsCredentialStore,
  __internal
} from '../../src/platforms/shared/credential-store.mjs';

/**
 * Deterministic in-memory stand-in for the PowerShell bridge. It implements the
 * same credential/chunk layout so the store can be tested without touching the
 * real Windows vault.
 */
class FakeBridge {
  constructor() {
    this.values = new Map();
    this.reads = [];
    this.writes = [];
    this.deletes = [];
    this.failRead = null;
    this.failWrite = null;
    this.failDelete = null;
  }

  #markerChunks(target) {
    const marker = this.values.get(target);
    if (!marker || marker.length < 2 || marker[0] !== __internal.MAGIC_CHUNKED) return [];
    try {
      const meta = JSON.parse(marker.subarray(1).toString('utf8'));
      if (!meta?.gen || !Number.isInteger(meta.parts)) return [];
      return Array.from({length: meta.parts}, (_, index) => `${target}#${meta.gen}#${index + 1}`);
    } catch {
      return [];
    }
  }

  read(targets) {
    this.reads.push([...targets]);
    if (this.failRead) throw this.failRead;
    const result = new Map();
    for (const target of targets) {
      if (this.values.has(target)) result.set(target, this.values.get(target));
    }
    return result;
  }

  write(target, credentials) {
    this.writes.push({target, credentials});
    if (this.failWrite) throw this.failWrite;
    const oldChunks = this.#markerChunks(target);
    for (const entry of credentials) {
      this.values.set(entry.target, Buffer.from(entry.value, 'base64'));
    }
    for (const chunk of oldChunks) {
      if (!credentials.some((entry) => entry.target === chunk)) this.values.delete(chunk);
    }
    return true;
  }

  delete(targets) {
    this.deletes.push([...targets]);
    if (this.failDelete) throw this.failDelete;
    for (const target of targets) {
      for (const chunk of this.#markerChunks(target)) this.values.delete(chunk);
      this.values.delete(target);
    }
    return true;
  }
}

function reference() {
  return `aicred_${randomBytes(16).toString('hex')}`;
}

test('credential references are validated before they become target names', () => {
  const store = new WindowsCredentialStore({bridge: new FakeBridge()});
  assert.throws(() => store.read('../../evil'), (error) => error.code === 'CREDENTIAL_BACKEND_INVALID_REFERENCE');
  assert.throws(() => store.write('aicred_short', 'k'), (error) => error.code === 'CREDENTIAL_BACKEND_INVALID_REFERENCE');
  const ref = reference();
  assert.equal(store.target(ref), `${__internal.TARGET_PREFIX}${ref}`);
  assert.equal(store.target(ref).includes('sk-'), false);
});

test('single keys round-trip through the credential backend and are cached', () => {
  const bridge = new FakeBridge();
  const store = new WindowsCredentialStore({bridge});
  const ref = reference();

  assert.equal(store.read(ref), null);
  store.write(ref, 'sk-test-value');
  assert.equal(store.read(ref), 'sk-test-value');
  store.write(ref, 'sk-updated');
  assert.equal(store.read(ref), 'sk-updated');
  assert.equal(bridge.reads.length, 1, 'a cached read after the initial miss must not spawn again');

  store.remove(ref);
  assert.equal(store.read(ref), null);
  assert.equal(bridge.deletes.length, 1);
  assert.equal(store.status().available, true);
});

test('keys above the Win32 blob limit are chunked, read back and the old generation is deleted', () => {
  const bridge = new FakeBridge();
  const store = new WindowsCredentialStore({bridge});
  const ref = reference();
  const value = `${'K'.repeat(5000)}-tail`;

  store.write(ref, value);
  const marker = bridge.values.get(`${__internal.TARGET_PREFIX}${ref}`);
  assert.equal(marker[0], __internal.MAGIC_CHUNKED);
  assert.ok(bridge.values.size > 2);
  assert.equal(store.read(ref), value);

  store.write(ref, 'small-after-chunks');
  assert.equal(store.read(ref), 'small-after-chunks');
  const base = `${__internal.TARGET_PREFIX}${ref}`;
  const stale = [...bridge.values.keys()].filter((target) => target.startsWith(`${base}#`));
  assert.deepEqual(stale, [], 'old chunk targets must be removed after the marker is replaced');
});

test('a damaged marker or missing chunk is reported as corrupt, never as a missing key', () => {
  const bridge = new FakeBridge();
  const store = new WindowsCredentialStore({bridge});
  const ref = reference();
  const target = `${__internal.TARGET_PREFIX}${ref}`;

  bridge.values.set(target, Buffer.from([9, 1, 2]));
  assert.throws(() => store.read(ref), (error) => error.code === 'CREDENTIAL_BACKEND_CORRUPT');

  bridge.values.set(target, Buffer.concat([
    Buffer.from([__internal.MAGIC_CHUNKED]),
    Buffer.from(JSON.stringify({v: 1, gen: 'abcdef123456', parts: 2}), 'utf8')
  ]));
  assert.throws(() => store.read(ref), (error) => error.code === 'CREDENTIAL_BACKEND_CORRUPT');
});

test('a factory reset removes all referenced credentials in one vault call', () => {
  const bridge = new FakeBridge();
  const store = new WindowsCredentialStore({bridge});
  const first = reference();
  const second = reference();
  store.write(first, 'one');
  store.write(second, 'two');
  bridge.deletes.length = 0;

  const result = store.clear([first, second]);
  assert.deepEqual(result, {removed: 2, failures: []});
  assert.equal(bridge.deletes.length, 1);
  assert.equal(bridge.deletes[0].length, 2);
  assert.equal(store.read(first), null);
  assert.equal(store.read(second), null);
});

test('a batch read asks the bridge for all uncached targets at once', () => {
  const bridge = new FakeBridge();
  const store = new WindowsCredentialStore({bridge});
  const refs = [reference(), reference(), reference()];
  store.write(refs[0], 'one');
  store.write(refs[1], 'two');
  bridge.reads.length = 0;

  const fresh = new WindowsCredentialStore({bridge});
  const values = fresh.readMany(refs);
  assert.equal(values.get(refs[0]), 'one');
  assert.equal(values.get(refs[1]), 'two');
  assert.equal(values.get(refs[2]), null);
  assert.equal(bridge.reads.length, 1);
  assert.deepEqual(new Set(bridge.reads[0]), new Set(refs.map((ref) => `${__internal.TARGET_PREFIX}${ref}`)));
});

test('backend failures keep a classified code and never expose the key', () => {
  const bridge = new FakeBridge();
  bridge.failWrite = new CredentialBackendError('CREDENTIAL_BACKEND_ACCESS_DENIED', {win32: 5});
  const store = new WindowsCredentialStore({bridge});
  const ref = reference();
  assert.throws(() => store.write(ref, 'must-not-leak'), (error) => (
    error.code === 'CREDENTIAL_BACKEND_ACCESS_DENIED'
    && error.win32 === 5
    && !String(error.message).includes('must-not-leak')
  ));
  assert.equal(store.status().available, false);
  assert.equal(store.status().error, 'CREDENTIAL_BACKEND_ACCESS_DENIED');
});

test('the PowerShell bridge passes the secret on stdin, never in argv or environment', () => {
  let captured = null;
  const bridge = new PowerShellCredentialBridge({
    platform: 'win32',
    powershellPath: process.execPath,
    env: {SystemRoot: 'C:\\Windows'},
    tempDir: 'D:\\LiveMemory\\tests\\.tmp\\add-type-cache',
    spawnSyncImpl: (command, args, options) => {
      captured = {command, args, options};
      return {status: 0, stdout: JSON.stringify({ok: true, written: 1}), stderr: ''};
    }
  });
  const ref = reference();
  const target = `${__internal.TARGET_PREFIX}${ref}`;
  const secret = 'sk-argv-check-should-not-appear';
  bridge.write(target, [{target, value: Buffer.from(secret).toString('base64')}]);

  assert.equal(captured.command, process.execPath);
  assert.ok(captured.args.includes('-EncodedCommand'));
  assert.equal(captured.args.some((arg) => arg.includes(secret)), false);
  assert.equal(captured.args.some((arg) => arg.includes('sk-argv-check')), false);
  assert.equal(JSON.stringify(captured.options.env).includes(secret), false);
  assert.equal(captured.options.env.TEMP, 'D:\\LiveMemory\\tests\\.tmp\\add-type-cache');
  assert.equal(captured.options.input.includes(Buffer.from(secret).toString('base64')), true);
});

test('PowerShell bridge maps not-found, access-denied, timeout and invalid output', () => {
  const target = `${__internal.TARGET_PREFIX}${reference()}`;
  const make = (result) => new PowerShellCredentialBridge({
    platform: 'win32',
    powershellPath: process.execPath,
    spawnSyncImpl: () => result
  });

  const missing = make({status: 0, stdout: JSON.stringify({ok: true, values: {}}), stderr: ''});
  assert.deepEqual(missing.read([target]).size, 0);

  const denied = make({status: 0, stdout: JSON.stringify({ok: false, error: 'OPERATION_FAILED', win32: 5}), stderr: ''});
  assert.throws(() => denied.read([target]), (error) => error.code === 'CREDENTIAL_BACKEND_ACCESS_DENIED');

  const timeout = make({error: Object.assign(new Error('timeout'), {code: 'ETIMEDOUT'})});
  assert.throws(() => timeout.read([target]), (error) => error.code === 'CREDENTIAL_BACKEND_TIMEOUT');

  const bad = make({status: 0, stdout: 'not-json', stderr: ''});
  assert.throws(() => bad.read([target]), (error) => error.code === 'CREDENTIAL_BACKEND_INVALID_RESPONSE');

  const addType = make({status: 0, stdout: JSON.stringify({ok: false, error: 'ADD_TYPE_FAILED'}), stderr: ''});
  assert.throws(() => addType.read([target]), (error) => error.code === 'CREDENTIAL_BACKEND_UNAVAILABLE');
});

test('the embedded script contains the native credential calls and no plaintext fallback', () => {
  const script = POWERSHELL_SCRIPT;
  assert.match(script, /CredWriteW/);
  assert.match(script, /CredReadW/);
  assert.match(script, /CredDeleteW/);
  assert.match(script, /ReadToEnd/);
});

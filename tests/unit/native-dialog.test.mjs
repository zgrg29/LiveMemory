import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {buildPickerScript, pickFolder} from '../../src/server/native-dialog.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';

function decodeScript(args) {
  const index = args.indexOf('-EncodedCommand');
  assert.ok(index >= 0, 'expected -EncodedCommand');
  return Buffer.from(args[index + 1], 'base64').toString('utf16le');
}

function resultFileFrom(script) {
  const match = /FromBase64String\('([^']+)'\)/.exec(script);
  assert.ok(match, 'expected base64 result path');
  return Buffer.from(match[1], 'base64').toString('utf8');
}

function fakeSpawn(handler) {
  return (...args) => {
    const child = new EventEmitter();
    child.kill = () => {
      child.killed = true;
    };
    setTimeout(() => handler(child, ...args), 5);
    return child;
  };
}

test('the picker script is fixed and carries paths only as base64', () => {
  const script = buildPickerScript({
    resultFile: 'C:\\临时 目录\\result.txt',
    initialDir: 'D:\\Live Data'
  });
  assert.match(script, /FolderBrowserDialog/);
  assert.match(script, /ShowDialog/);
  assert.match(script, /WriteAllText/);
  assert.match(script, /UTF8Encoding/);
  assert.doesNotMatch(script, /C:\\临时/);
  assert.doesNotMatch(script, /D:\\Live Data/);
  assert.equal(resultFileFrom(script), 'C:\\临时 目录\\result.txt');
});

test('the picker returns an absolute path with spaces and non-ASCII characters', async () => {
  const temp = createTempDir();
  try {
    let scriptText = '';
    const spawnImpl = fakeSpawn((child, executable, args) => {
      scriptText = decodeScript(args);
      writeFileSync(resultFileFrom(scriptText), 'C:\\Users\\测试 User\\Live Data', 'utf8');
      child.emit('exit', 0);
    });
    const selected = await pickFolder({workDir: temp.dir, spawnImpl, timeoutMs: 5000});
    assert.equal(selected, 'C:\\Users\\测试 User\\Live Data');
    assert.match(scriptText, /FolderBrowserDialog/);
  } finally {
    temp.cleanup();
  }
});

test('cancelling the picker is not an error and leaves no result file', async () => {
  const temp = createTempDir();
  try {
    let resultFile = '';
    const spawnImpl = fakeSpawn((child, executable, args) => {
      const script = decodeScript(args);
      resultFile = resultFileFrom(script);
      child.emit('exit', 0);
    });
    const selected = await pickFolder({workDir: temp.dir, spawnImpl, timeoutMs: 5000});
    assert.equal(selected, null);
    assert.equal(existsSync(resultFile), false);
  } finally {
    temp.cleanup();
  }
});

test('a script error is surfaced with its message and result file cleaned up', async () => {
  const temp = createTempDir();
  try {
    let resultFile = '';
    const spawnImpl = fakeSpawn((child, executable, args) => {
      const script = decodeScript(args);
      resultFile = resultFileFrom(script);
      writeFileSync(resultFile, 'ERROR:user cancelled in a broken dialog', 'utf8');
      child.emit('exit', 1);
    });
    await assert.rejects(
      () => pickFolder({workDir: temp.dir, spawnImpl, timeoutMs: 5000}),
      (error) => {
        assert.equal(error.code, 'PICKER_FAILED');
        assert.match(error.details.message, /broken dialog/);
        return true;
      }
    );
    assert.equal(existsSync(resultFile), false);
  } finally {
    temp.cleanup();
  }
});

test('spawn failure is reported as PICKER_FAILED, not a silent cancel', async () => {
  const temp = createTempDir();
  try {
    const spawnImpl = () => {
      throw Object.assign(new Error('spawn EPERM'), {code: 'EPERM'});
    };
    await assert.rejects(
      () => pickFolder({workDir: temp.dir, spawnImpl, timeoutMs: 5000}),
      (error) => error.code === 'PICKER_FAILED' && error.details.code === 'EPERM'
    );
  } finally {
    temp.cleanup();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {createStartupLog, startupLogCandidates} from '../../src/launcher/startup-log.mjs';

test('writes a JSON-lines startup log into the data folder', () => {
  const temp = createTempDir();
  const log = createStartupLog({dataDir: temp.dir, env: {}, argv: ['--no-open']});
  log.record('data-dir', {ok: true, dir: temp.dir});
  log.fail('instance-lock', Object.assign(new Error('denied'), {code: 'EPERM'}), {path: 'runtime'});
  assert.equal(log.fallback(), false);
  const file = log.file();
  assert.ok(existsSync(file));
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const steps = lines.map((line) => line.step);
  assert.ok(steps.includes('startup.begin'));
  assert.ok(steps.includes('data-dir'));
  const failure = lines.find((line) => line.step === 'instance-lock');
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'EPERM');
  assert.ok(failure.stack);
  assert.equal(log.lastFailure().code, 'EPERM');
  temp.cleanup();
});

test('falls back to the temp folder when the data folder cannot hold logs', () => {
  const temp = createTempDir();
  const blocker = join(temp.dir, 'blocked');
  writeFileSync(blocker, 'x');
  const log = createStartupLog({
    env: {LIVE_MEMORY_LOG_DIR: join(blocker, 'logs')},
    dataDir: join(blocker, 'data'),
    fileFor: (dir) => join(dir, 'startup-test.log')
  });
  log.record('startup.begin');
  assert.equal(log.fallback(), true);
  assert.ok(log.file());
  assert.ok(log.file().startsWith(tmpdir()));
  temp.cleanup();
});

test('never writes cookies or tokens into the log', () => {
  const temp = createTempDir();
  const log = createStartupLog({dataDir: temp.dir, env: {}, fileFor: (dir) => join(dir, 'startup-redact.log')});
  log.record('login', {cookie: 'SESSDATA=secret-value', note: 'Cookie: SESSDATA=secret-value; bili_jct=abc'});
  const text = readFileSync(log.file(), 'utf8');
  assert.equal(text.includes('secret-value'), false);
  assert.ok(text.includes('[redacted]') || text.includes('cookie'));
  temp.cleanup();
});

test('candidate log folders always include a temp fallback', () => {
  const candidates = startupLogCandidates({env: {}, dataDir: 'C:/data/lm', home: 'C:/Users/x'});
  assert.equal(candidates[0], 'C:\\data\\lm\\logs');
  assert.ok(candidates.some((item) => item.includes('LiveMemory-logs')));
});

test('the log moves into the resolved data folder and keeps the early records', () => {
  const temp = createTempDir();
  const log = createStartupLog({
    env: {},
    dataDir: null,
    fileFor: (dir) => join(dir, 'startup-relocate.log')
  });
  log.record('startup.begin');
  log.record('console.ready');
  const dataDir = join(temp.dir, 'data');
  assert.equal(log.relocate(dataDir), true);
  assert.equal(log.dir(), join(dataDir, 'logs'));
  const content = readFileSync(join(dataDir, 'logs', 'startup-relocate.log'), 'utf8');
  assert.match(content, /"step":"startup.begin"/);
  assert.match(content, /"step":"console.ready"/);
  log.record('data-dir', {ok: true});
  assert.match(readFileSync(join(dataDir, 'logs', 'startup-relocate.log'), 'utf8'), /"step":"data-dir"/);
  temp.cleanup();
});

test('relocation is skipped when the data folder cannot hold a log', () => {
  const temp = createTempDir();
  const blocker = join(temp.dir, 'blocked');
  writeFileSync(blocker, 'x');
  const log = createStartupLog({env: {}, dataDir: null, fileFor: (dir) => join(dir, 'startup-relocate.log')});
  log.record('startup.begin');
  const before = log.file();
  assert.equal(log.relocate(join(blocker, 'data')), false);
  assert.equal(log.file(), before);
  temp.cleanup();
});

test('a failure report is valid JSON with the failing step', () => {  const temp = createTempDir();
  const log = createStartupLog({dataDir: temp.dir, env: {}, fileFor: (dir) => join(dir, 'startup-report.log')});
  log.fail('prepare-directories', Object.assign(new Error('nope'), {code: 'EACCES'}));
  const report = log.writeErrorReport({code: 'EACCES', step: 'prepare-directories'});
  const parsed = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(parsed.code, 'EACCES');
  assert.ok(parsed.steps.some((step) => step.step === 'prepare-directories' && step.ok === false));
  temp.cleanup();
});

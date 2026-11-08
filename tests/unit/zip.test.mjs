import test from 'node:test';
import assert from 'node:assert/strict';
import {createZip, crc32, readZipEntry, readZipIndex, sha256Of} from '../../src/shared/zip.mjs';

test('crc32 matches the known reference value', () => {
  // CRC-32 of "123456789" is 0xCBF43926.
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('creates a readable single-file archive', () => {
  const archive = createZip([{name: 'hello.txt', data: 'hello world'}]);
  const entries = readZipIndex(archive);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'hello.txt');
  assert.equal(entries[0].method, 0);
  assert.equal(readZipEntry(archive, 'hello.txt').toString('utf8'), 'hello world');
});

test('supports UTF-8 names and multiple entries without compression loss', () => {
  const content = '日本語のテキストと中文内容\n'.repeat(50);
  const archive = createZip([
    {name: 'manifest.json', data: '{"a":1}'},
    {name: 'messages.jsonl', data: content},
    {name: 'nested/path/file.txt', data: Buffer.from('binary-ish')}
  ]);
  const names = readZipIndex(archive).map((entry) => entry.name);
  assert.deepEqual(names, ['manifest.json', 'messages.jsonl', 'nested/path/file.txt']);
  assert.equal(readZipEntry(archive, 'messages.jsonl').toString('utf8'), content);
  assert.equal(sha256Of(Buffer.from('x')), sha256Of(Buffer.from('x')));
});

test('rejects path traversal and absolute entry names', () => {
  assert.throws(() => createZip([{name: '../evil.txt', data: 'x'}]), /path traversal/);
  assert.throws(() => createZip([{name: '/etc/passwd', data: 'x'}]), /invalid entry name/);
  assert.throws(() => createZip([{name: 'a/../../b', data: 'x'}]), /path traversal/);
});

test('rejects empty archives and missing entries', () => {
  assert.throws(() => createZip([]), /no entries/);
  const archive = createZip([{name: 'a.txt', data: 'a'}]);
  assert.throws(() => readZipEntry(archive, 'missing.txt'), /not found/);
  assert.throws(() => readZipIndex(Buffer.from('nope')), /not an archive/);
});

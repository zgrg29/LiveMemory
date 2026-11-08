import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {createSession, getSession} from '../../src/storage/repositories/sessions.mjs';
import {listPackages} from '../../src/storage/repositories/ai-packages.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';
import {buildAnalysisPackage, inspectAnalysisPackage} from '../../src/ai/export/package.mjs';
import {chatEvent, giftEvent, superChatEvent} from '../helpers/fixtures.mjs';
import {createHash} from 'node:crypto';
import {readZipEntry} from '../../src/shared/zip.mjs';

const EXPORTS_DIR = 'exports';

async function seededDb(temp) {
  const db = openDatabase({memory: true});
  migrate(db);
  const session = createSession(db, {
    platform: 'mock',
    roomTitle: 'Package test',
    storageMode: 'compact',
    sourceQuality: 'mock',
    simulated: true,
    startedAt: Date.parse('2026-11-08T10:00:00.000Z')
  });
  const ingest = new EventIngest({db});
  ingest.record(chatEvent({session_id: session.id, viewer_uid: 'a', display_name: 'Alice', external_id: 'a1', occurred_at: Date.parse('2026-11-08T10:00:01.000Z')}));
  ingest.record(chatEvent({session_id: session.id, viewer_uid: 'b', display_name: 'Bob', external_id: 'b1', occurred_at: Date.parse('2026-11-08T10:00:02.000Z')}));
  ingest.record(superChatEvent({session_id: session.id, viewer_uid: 'b', display_name: 'Bob', external_id: 'b2', occurred_at: Date.parse('2026-11-08T10:00:03.000Z')}));
  ingest.record(giftEvent({session_id: session.id, viewer_uid: 'a', display_name: 'Alice', external_id: 'a2', occurred_at: Date.parse('2026-11-08T10:00:04.000Z')}));
  return {db, session};
}

test('analysis package contains localized instructions, ordered messages and verifiable checksums', async () => {
  const temp = createTempDir();
  const {db, session} = await seededDb(temp);
  const result = await buildAnalysisPackage({
    db,
    sessionId: session.id,
    locale: 'ja',
    exportsDir: join(temp.dir, EXPORTS_DIR),
    now: Date.parse('2026-11-08T10:00:10.000Z')
  });
  assert.ok(result);
  assert.equal(result.locale, 'ja');
  assert.equal(result.messageCount, 3, 'chat + chat + super chat');

  const archive = readFileSync(result.absolutePath);
  const {names, manifest, messages} = await inspectAnalysisPackage(result.absolutePath);
  assert.deepEqual(names.sort(), [
    'instructions.md', 'manifest.json', 'messages.jsonl', 'result.schema.json', 'session_context.json', 'viewer_context.json'
  ]);
  assert.equal(manifest.protocol, 'livememory-analysis-v1');
  assert.equal(manifest.result_protocol, 'livememory-analysis-result-v1');
  assert.equal(manifest.session_id, session.id);
  assert.equal(manifest.counts.messages, 3);
  assert.equal(manifest.counts.viewers, 2);
  assert.equal(manifest.tasks.length, 2);

  const seqs = messages.map((line) => JSON.parse(line).seq);
  assert.deepEqual(seqs, [1, 2, 3]);
  assert.ok(messages.every((line) => line.endsWith('}')));

  for (const file of manifest.files) {
    const content = readZipEntry(archive, file.name);
    assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256, `${file.name} checksum`);
  }

  const instructions = readZipEntry(archive, 'instructions.md').toString('utf8');
  assert.match(instructions, /パッケージの内容/);
  assert.match(instructions, /信頼できないデータ/);
  assert.doesNotMatch(instructions, /Package contents/);

  const sessionContext = JSON.parse(readZipEntry(archive, 'session_context.json').toString('utf8'));
  assert.equal(sessionContext.session.simulated, true);
  assert.equal(sessionContext.economic_support[0].currency, 'CNY');

  assert.equal(listPackages(db, {sessionId: session.id}).length, 1);
  assert.equal(getSession(db, session.id).ai_status, 'exported');
  assert.ok(result.checksum.match(/^[0-9a-f]{64}$/));
  closeDatabase(db);
  temp.cleanup();
});

test('localized instructions do not leak English headings into Chinese', async () => {
  const temp = createTempDir();
  const {db, session} = await seededDb(temp);
  const result = await buildAnalysisPackage({
    db,
    sessionId: session.id,
    locale: 'zh-CN',
    exportsDir: join(temp.dir, EXPORTS_DIR)
  });
  const {names} = await inspectAnalysisPackage(result.absolutePath);
  const archive = readFileSync(result.absolutePath);
  const instructions = readZipEntry(archive, 'instructions.md').toString('utf8');
  assert.match(instructions, /分析包内容/);
  assert.match(instructions, /不可信数据/);
  assert.ok(names.includes('result.schema.json'));
  closeDatabase(db);
  temp.cleanup();
});

test('an unknown session produces no package', async () => {
  const temp = createTempDir();
  const db = openDatabase({memory: true});
  migrate(db);
  const result = await buildAnalysisPackage({
    db,
    sessionId: 'ses_missing',
    locale: 'en',
    exportsDir: join(temp.dir, EXPORTS_DIR)
  });
  assert.equal(result, null);
  assert.equal(listPackages(db, {}).length, 0);
  closeDatabase(db);
  temp.cleanup();
});

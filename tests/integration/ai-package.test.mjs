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

test('the AI package keeps raw text + emoji, uses one emote dictionary and marks unknown emotes', async () => {
  const temp = createTempDir();
  const db = openDatabase({memory: true});
  migrate(db);
  const session = createSession(db, {
    platform: 'bilibili',
    roomTitle: 'Emoji and emotes',
    storageMode: 'compact',
    sourceQuality: 'estimated',
    simulated: false,
    startedAt: Date.parse('2026-11-08T10:00:00.000Z')
  });
  const ingest = new EventIngest({db});
  const base = {platform: 'bilibili', session_id: session.id, viewer_uid: '42', display_name: '观众', occurred_at: Date.parse('2026-11-08T10:00:01.000Z')};
  ingest.record(chatEvent({...base, external_id: 'emoji-1', content: '今天太开心了😂❤️'}));
  ingest.record(chatEvent({
    ...base,
    external_id: 'emote-1',
    content: '就这',
    emotes: [{id: 'room_5050_96171', name: '就这', source: 'bilibili.info13'}]
  }));
  ingest.record(chatEvent({
    ...base,
    external_id: 'emote-2',
    content: '今天这个剧情太好笑了😂[猫猫鼓掌]',
    emotes: [{id: 'room_cat', code: '[猫猫鼓掌]', name: '猫猫鼓掌', source: 'bilibili.info13'}]
  }));
  ingest.record(chatEvent({
    ...base,
    external_id: 'emote-3',
    content: '今天太有意思了',
    emotes: [{id: 'room_cat', code: '[猫猫鼓掌]', name: '猫猫鼓掌', source: 'bilibili.info13'}]
  }));
  ingest.record(chatEvent({
    ...base,
    external_id: 'emote-4',
    content: null,
    emotes: [{id: 'room_unknown', source: 'bilibili.info13'}]
  }));
  // Same emote again: the dictionary count grows, the metadata is not repeated.
  ingest.record(chatEvent({
    ...base,
    external_id: 'emote-5',
    content: '就这',
    emotes: [{id: 'room_5050_96171', name: '就这', source: 'bilibili.info13'}]
  }));

  const result = await buildAnalysisPackage({
    db,
    sessionId: session.id,
    locale: 'zh-CN',
    exportsDir: join(temp.dir, EXPORTS_DIR),
    now: Date.parse('2026-11-08T10:00:10.000Z')
  });
  const archive = readFileSync(result.absolutePath);
  const sessionContext = JSON.parse(readZipEntry(archive, 'session_context.json').toString('utf8'));
  const messages = readZipEntry(archive, 'messages.jsonl').toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const instructions = readZipEntry(archive, 'instructions.md').toString('utf8');

  assert.equal(result.messageCount, 6);
  assert.equal(sessionContext.counts.messages_with_emotes, 5);
  assert.equal(sessionContext.counts.emote_kinds, 3);
  assert.equal(sessionContext.emote_dictionary.length, 3);
  const dict = Object.fromEntries(sessionContext.emote_dictionary.map((entry) => [entry.key, entry]));
  assert.equal(dict['bilibili:id:room_5050_96171'].count, 2);
  assert.equal(dict['bilibili:id:room_cat'].count, 2);
  assert.equal(dict['bilibili:id:room_unknown'].id, 'room_unknown');

  // Raw text is never rewritten; emoji survive the trip through SQLite, ZIP and JSONL.
  assert.equal(messages[0].content, '今天太开心了😂❤️');
  assert.equal(messages[1].content, '就这');
  assert.equal(messages[2].content, '今天这个剧情太好笑了😂[猫猫鼓掌]');

  assert.equal(messages[1].content_ai, undefined, 'label already in text: no duplicate annotation');
  assert.equal(messages[2].content_ai, undefined, 'bracketed label already in text');
  assert.equal(messages[3].content_ai, '今天太有意思了[平台表情：猫猫鼓掌]');
  assert.equal(messages[4].content, null);
  assert.equal(messages[4].content_ai, '[未知平台表情：emote_id=room_unknown]');
  assert.deepEqual(messages[1].emote_refs, ['bilibili:id:room_5050_96171']);
  assert.deepEqual(messages[3].emote_refs, ['bilibili:id:room_cat']);

  assert.match(instructions, /## 表情与 Emoji/);
  assert.match(instructions, /未知平台表情/);
  assert.match(instructions, /\[笑哭\]/);
  assert.match(instructions, /不是确定的情绪标签/);

  closeDatabase(db);
  temp.cleanup();
});

test('repeating one emote does not inflate the package with per-message metadata', async () => {
  const temp = createTempDir();
  const db = openDatabase({memory: true});
  migrate(db);
  const session = createSession(db, {
    platform: 'bilibili',
    roomTitle: 'Repeated emote',
    storageMode: 'compact',
    sourceQuality: 'estimated',
    simulated: false,
    startedAt: Date.parse('2026-11-08T10:00:00.000Z')
  });
  const ingest = new EventIngest({db});
  for (let index = 0; index < 200; index += 1) {
    ingest.record(chatEvent({
      platform: 'bilibili',
      session_id: session.id,
      viewer_uid: String(index % 10),
      display_name: `观众${index % 10}`,
      external_id: `repeat-${index}`,
      occurred_at: Date.parse('2026-11-08T10:00:00.000Z') + index * 1000,
      content: '太强了[鼓掌]',
      emotes: [{id: 'room_clap', code: '[鼓掌]', name: '鼓掌', source: 'bilibili.info13'}]
    }));
  }
  const result = await buildAnalysisPackage({
    db,
    sessionId: session.id,
    locale: 'zh-CN',
    exportsDir: join(temp.dir, EXPORTS_DIR)
  });
  const archive = readFileSync(result.absolutePath);
  const sessionContext = JSON.parse(readZipEntry(archive, 'session_context.json').toString('utf8'));
  const raw = readZipEntry(archive, 'messages.jsonl').toString('utf8');
  const lines = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(sessionContext.emote_dictionary.length, 1);
  assert.equal(sessionContext.emote_dictionary[0].count, 200);
  assert.equal(lines.length, 200);
  assert.ok(lines.every((line) => Array.isArray(line.emote_refs) && line.emote_refs.length === 1));
  assert.ok(lines.every((line) => line.content_ai === undefined), 'the label is already in the text');
  assert.ok(!raw.includes('"emotes"'), 'messages only reference the dictionary');
  assert.ok(Buffer.byteLength(raw, 'utf8') < 64 * 1024, `messages.jsonl is ${Buffer.byteLength(raw, 'utf8')} bytes`);
  closeDatabase(db);
  temp.cleanup();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase, withTransaction} from '../../src/storage/database/connection.mjs';
import {currentSchemaVersion, migrate, MIGRATIONS} from '../../src/storage/database/migrations/index.mjs';

const T0 = Date.parse('2026-11-13T10:00:00.000Z');

function buildVersion13Database() {
  const db = openDatabase({memory: true});
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 13).sort((a, b) => a.version - b.version)) {
    withTransaction(db, () => {
      migration.up(db);
      record.run(migration.version, migration.name, T0);
    });
  }
  return db;
}

test('v13 upgrades to v14 by adding translation tables only', () => {
  const db = buildVersion13Database();
  try {
    assert.equal(currentSchemaVersion(db), 13);
    db.prepare(`
      INSERT INTO sessions (id, platform, status, storage_mode, started_at, created_at, updated_at)
      VALUES ('ses_v13', 'mock', 'ended', 'compact', ?, ?, ?)
    `).run(T0, T0, T0);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_translations'").get(),
      undefined
    );

    const result = migrate(db, {now: T0 + 1000});
    assert.deepEqual(result, {from: 13, to: 14, applied: [14]});
    assert.equal(currentSchemaVersion(db), 14);

    for (const table of ['ai_translations', 'ai_translation_runs']) {
      assert.ok(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        `missing ${table}`
      );
    }
    const columns = db.prepare('PRAGMA table_info(ai_translations)').all().map((row) => row.name);
    for (const column of [
      'target_kind', 'target_id', 'item_path', 'target_locale', 'source_hash',
      'translated_text', 'status', 'translator_version'
    ]) {
      assert.ok(columns.includes(column), `missing column ${column}`);
    }

    // Existing rows are untouched.
    assert.equal(
      db.prepare('SELECT id FROM sessions WHERE id = ?').get('ses_v13')?.id,
      'ses_v13'
    );
    // Re-running is a no-op.
    assert.deepEqual(migrate(db, {now: T0 + 2000}), {from: 14, to: 14, applied: []});
  } finally {
    db.close();
  }
});

test('translation cache rows cascade with their session', () => {
  const db = openDatabase({memory: true});
  migrate(db);
  try {
    db.prepare(`
      INSERT INTO sessions (id, platform, status, storage_mode, started_at, created_at, updated_at)
      VALUES ('ses_tr', 'mock', 'ended', 'compact', ?, ?, ?)
    `).run(T0, T0, T0);
    db.prepare(`
      INSERT INTO ai_translations (
        id, session_id, target_kind, target_id, item_path, target_locale,
        source_hash, source_locale, translated_text, status, translator_version,
        created_at, updated_at
      ) VALUES ('atl_1', 'ses_tr', 'session_result', 'air_1', 'summary', 'zh-CN',
        'hash', 'ja', 'translated', 'ok', 'lm-translation-v1', ?, ?)
    `).run(T0, T0);
    db.prepare(`
      INSERT INTO ai_translation_runs (
        id, session_id, target_locale, status, translator_version, started_at, updated_at
      ) VALUES ('atr_1', 'ses_tr', 'zh-CN', 'complete', 'lm-translation-v1', ?, ?)
    `).run(T0, T0);

    db.prepare('DELETE FROM sessions WHERE id = ?').run('ses_tr');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM ai_translations').get().c), 0);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM ai_translation_runs').get().c), 0);
  } finally {
    db.close();
  }
});

import {withTransaction} from '../connection.mjs';

/**
 * Schema migrations.
 *
 * Rules:
 * - Migrations are append only. Never edit an applied migration.
 * - Each migration runs inside a transaction and is recorded by version.
 * - Application version and schema version are independent.
 */

const INITIAL_SQL = `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  platform_room_id TEXT,
  room_title TEXT,
  broadcaster_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('live', 'ended', 'interrupted')),
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('compact', 'full')),
  source_quality TEXT NOT NULL DEFAULT 'unknown',
  simulated INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_event_at INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  gift_event_count INTEGER NOT NULL DEFAULT 0,
  payment_event_count INTEGER NOT NULL DEFAULT 0,
  ai_status TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);

CREATE TABLE IF NOT EXISTS viewers (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  platform_uid TEXT NOT NULL,
  nickname TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  payment_event_count INTEGER NOT NULL DEFAULT 0,
  focused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (platform, platform_uid)
);

CREATE INDEX IF NOT EXISTS idx_viewers_last_seen ON viewers (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS viewer_nicknames (
  viewer_id TEXT NOT NULL REFERENCES viewers (id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (viewer_id, nickname)
);

CREATE TABLE IF NOT EXISTS viewer_sessions (
  viewer_id TEXT NOT NULL REFERENCES viewers (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  message_count INTEGER NOT NULL DEFAULT 0,
  payment_event_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (viewer_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_viewer_sessions_session ON viewer_sessions (session_id);

CREATE TABLE IF NOT EXISTS viewer_currency_totals (
  viewer_id TEXT NOT NULL REFERENCES viewers (id) ON DELETE CASCADE,
  currency TEXT NOT NULL,
  value_kind TEXT NOT NULL CHECK (value_kind IN ('actual', 'display', 'unknown')),
  total_minor INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (viewer_id, currency, value_kind)
);

CREATE TABLE IF NOT EXISTS session_currency_totals (
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  currency TEXT NOT NULL,
  value_kind TEXT NOT NULL CHECK (value_kind IN ('actual', 'display', 'unknown')),
  total_minor INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, currency, value_kind)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  external_id TEXT,
  event_type TEXT NOT NULL,
  viewer_id TEXT REFERENCES viewers (id) ON DELETE SET NULL,
  viewer_uid TEXT,
  display_name TEXT,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  content TEXT,
  gift_id TEXT,
  gift_name TEXT,
  gift_type TEXT,
  gift_quantity INTEGER NOT NULL DEFAULT 1,
  unit_amount_minor INTEGER,
  amount_minor INTEGER,
  currency TEXT,
  value_kind TEXT NOT NULL DEFAULT 'unknown',
  is_paid INTEGER NOT NULL DEFAULT 0,
  source_quality TEXT NOT NULL DEFAULT 'unknown',
  dedupe_key TEXT NOT NULL,
  content_purged_at INTEGER,
  UNIQUE (session_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_events_session_time ON events (session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_viewer_time ON events (viewer_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type);

CREATE TABLE IF NOT EXISTS ai_packages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  locale TEXT NOT NULL,
  file_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_packages_session ON ai_packages (session_id, created_at DESC);
`;

export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      db.exec(INITIAL_SQL);
    }
  },
  {
    version: 2,
    name: 'event-emote-metadata',
    up(db) {
      // Optional JSON array of platform emote metadata. Old rows stay NULL and
      // old databases are upgraded in place; no table rewrite is required.
      db.exec('ALTER TABLE events ADD COLUMN emotes TEXT');
    }
  },
  {
    version: 3,
    name: 'session-platform-start',
    up(db) {
      // The platform's own broadcast start time (e.g. YouTube
      // `liveStreamingDetails.actualStartTime`), distinct from the moment the
      // user started recording. Used to show time relative to the stream.
      db.exec('ALTER TABLE sessions ADD COLUMN platform_started_at INTEGER');
    }
  },
  {
    version: 4,
    name: 'event-badges-and-amount-display',
    up(db) {
      // Confirmed author badges (owner/moderator/verified/member) and the raw
      // money string as displayed by the platform. The latter is kept alongside
      // the parsed integer amount so an ambiguous symbol can be audited later.
      db.exec('ALTER TABLE events ADD COLUMN badges TEXT');
      db.exec('ALTER TABLE events ADD COLUMN amount_display TEXT');
    }
  }
]);

export function currentSchemaVersion(db) {
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  return Number(row?.version ?? 0);
}

/**
 * Apply every pending migration.
 * @returns {{from: number, to: number, applied: number[]}}
 */
export function migrate(db, {now = Date.now(), log = () => {}} = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const before = currentSchemaVersion(db);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version))
  );
  const pending = MIGRATIONS
    .filter((migration) => !applied.has(migration.version))
    .sort((a, b) => a.version - b.version);

  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  const appliedVersions = [];
  for (const migration of pending) {
    withTransaction(db, () => {
      migration.up(db);
      record.run(migration.version, migration.name, now);
    });
    appliedVersions.push(migration.version);
    log({event: 'migration.applied', version: migration.version, name: migration.name});
  }
  return {from: before, to: currentSchemaVersion(db), applied: appliedVersions};
}

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
  },
  {
    version: 5,
    name: 'broadcaster-identity-and-viewer-context',
    up(db) {      // A stable broadcaster (channel) is the third identity axis. Viewers keep
      // one global platform identity, but every "broadcaster × viewer" pair gets
      // its own interaction context so statistics and future AI profiles from
      // different channels are never mixed.
      db.exec(`
        CREATE TABLE IF NOT EXISTS broadcasters (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          platform_uid TEXT NOT NULL,
          display_name TEXT,
          identity_quality TEXT NOT NULL DEFAULT 'verified'
            CHECK (identity_quality IN ('verified', 'room_fallback', 'simulated', 'unresolved')),
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (platform, platform_uid)
        );

        CREATE INDEX IF NOT EXISTS idx_broadcasters_last_seen ON broadcasters (last_seen_at DESC);

        CREATE TABLE IF NOT EXISTS viewer_broadcasters (
          viewer_id TEXT NOT NULL REFERENCES viewers (id) ON DELETE CASCADE,
          broadcaster_id TEXT NOT NULL REFERENCES broadcasters (id) ON DELETE CASCADE,
          message_count INTEGER NOT NULL DEFAULT 0,
          payment_event_count INTEGER NOT NULL DEFAULT 0,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (viewer_id, broadcaster_id)
        );

        CREATE INDEX IF NOT EXISTS idx_viewer_broadcasters_broadcaster
          ON viewer_broadcasters (broadcaster_id, message_count DESC);

        CREATE TABLE IF NOT EXISTS viewer_broadcaster_currency_totals (
          viewer_id TEXT NOT NULL,
          broadcaster_id TEXT NOT NULL,
          currency TEXT NOT NULL,
          value_kind TEXT NOT NULL CHECK (value_kind IN ('actual', 'display', 'unknown')),
          total_minor INTEGER NOT NULL DEFAULT 0,
          event_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (viewer_id, broadcaster_id, currency, value_kind),
          FOREIGN KEY (viewer_id, broadcaster_id)
            REFERENCES viewer_broadcasters (viewer_id, broadcaster_id) ON DELETE CASCADE
        );
      `);
      db.exec('ALTER TABLE sessions ADD COLUMN broadcaster_id TEXT REFERENCES broadcasters (id) ON DELETE SET NULL');
      db.exec("ALTER TABLE sessions ADD COLUMN broadcaster_identity TEXT NOT NULL DEFAULT 'unresolved'");
      db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_broadcaster ON sessions (broadcaster_id, started_at DESC)');

      // Backfill. Historical Bilibili sessions have a verified room id but no
      // anchor uid, so they are attributed to a room-level fallback identity and
      // marked as such. YouTube history only knows the single video id, which is
      // NOT a broadcaster identity: those rows stay unresolved and are kept.
      db.exec(`
        INSERT INTO broadcasters (
          id, platform, platform_uid, display_name, identity_quality,
          first_seen_at, last_seen_at, created_at, updated_at
        )
        SELECT 'bilibili:room:' || s.platform_room_id,
               'bilibili',
               s.platform_room_id,
               (SELECT s2.broadcaster_name
                  FROM sessions s2
                 WHERE s2.platform = 'bilibili'
                   AND s2.platform_room_id = s.platform_room_id
                   AND s2.broadcaster_name IS NOT NULL
                 ORDER BY s2.started_at DESC
                 LIMIT 1),
               'room_fallback',
               MIN(s.started_at), MAX(s.started_at), MAX(s.updated_at), MAX(s.updated_at)
          FROM sessions s
         WHERE s.platform = 'bilibili'
           AND s.platform_room_id IS NOT NULL
           AND TRIM(s.platform_room_id) <> ''
         GROUP BY s.platform_room_id;
      `);
      db.exec(`
        UPDATE sessions
           SET broadcaster_id = 'bilibili:room:' || platform_room_id,
               broadcaster_identity = 'room_fallback'
         WHERE platform = 'bilibili'
           AND platform_room_id IS NOT NULL
           AND TRIM(platform_room_id) <> ''
           AND EXISTS (
             SELECT 1 FROM broadcasters b
              WHERE b.id = 'bilibili:room:' || sessions.platform_room_id
           );
      `);
      db.exec(`
        INSERT INTO broadcasters (
          id, platform, platform_uid, display_name, identity_quality,
          first_seen_at, last_seen_at, created_at, updated_at
        )
        SELECT 'mock:simulation', 'mock', 'simulation', NULL, 'simulated',
               MIN(started_at), MAX(started_at), MAX(updated_at), MAX(updated_at)
          FROM sessions
         WHERE platform = 'mock'
        HAVING COUNT(*) > 0;
      `);
      db.exec(`
        UPDATE sessions
           SET broadcaster_id = 'mock:simulation',
               broadcaster_identity = 'simulated'
         WHERE platform = 'mock';
      `);

      // Rebuild the broadcaster-scoped aggregates from the authoritative
      // per-session rows so pre-v5 history is immediately usable in the new UI.
      db.exec(`
        INSERT INTO viewer_broadcasters (
          viewer_id, broadcaster_id, message_count, payment_event_count,
          first_seen_at, last_seen_at, created_at, updated_at
        )
        SELECT vs.viewer_id, s.broadcaster_id,
               SUM(vs.message_count), SUM(vs.payment_event_count),
               MIN(vs.first_seen_at), MAX(vs.last_seen_at),
               MAX(vs.last_seen_at), MAX(vs.last_seen_at)
          FROM viewer_sessions vs
          JOIN sessions s ON s.id = vs.session_id
         WHERE s.broadcaster_id IS NOT NULL
         GROUP BY vs.viewer_id, s.broadcaster_id;
      `);
      db.exec(`
        INSERT INTO viewer_broadcaster_currency_totals (
          viewer_id, broadcaster_id, currency, value_kind, total_minor, event_count
        )
        SELECT e.viewer_id, s.broadcaster_id, e.currency, e.value_kind,
               SUM(e.amount_minor), COUNT(*)
          FROM events e
          JOIN sessions s ON s.id = e.session_id
         WHERE s.broadcaster_id IS NOT NULL
           AND e.viewer_id IS NOT NULL
           AND e.is_paid = 1
           AND e.amount_minor > 0
           AND e.value_kind IN ('actual', 'display')
           AND e.currency IS NOT NULL
         GROUP BY e.viewer_id, s.broadcaster_id, e.currency, e.value_kind;
      `);
    }
  },
  {
    version: 6,
    name: 'session-leaderboard-index',
    up(db) {
      // The live page shows the top 100 speakers of one session. A covering
      // index (session, message count) keeps that query cheap even for a very
      // busy broadcast and is the only schema change required for the feature.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_viewer_sessions_speakers
          ON viewer_sessions (session_id, message_count DESC);
      `);
    }
  },
  {
    version: 7,
    name: 'session-archive-end-reason-and-history-search',
    up(db) {
      // Archive is a management attribute, deliberately separate from the
      // capture `status`: an ended/interrupted session can be archived and
      // unarchived without ever looking like a running capture again.
      db.exec('ALTER TABLE sessions ADD COLUMN archived_at INTEGER');
      // Why the local capture ended. `status = ended` means "no capture is
      // running"; it must not be presented as "the platform broadcast ended".
      // Values: user / adapter_end / failed / shutdown / startup_recovery.
      db.exec('ALTER TABLE sessions ADD COLUMN end_reason TEXT');

      // History lists filter by archive/platform/status and order by start time;
      // search only ever scans sessions + viewers + viewer_sessions (never the
      // raw event table), so these indexes bound the cost as data grows.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_history
          ON sessions (archived_at, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_platform_started
          ON sessions (platform, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_viewers_nickname
          ON viewers (nickname);
        CREATE INDEX IF NOT EXISTS idx_viewer_nicknames_nickname
          ON viewer_nicknames (nickname);
        CREATE INDEX IF NOT EXISTS idx_viewer_sessions_viewer_seen
          ON viewer_sessions (viewer_id, last_seen_at DESC);
      `);
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

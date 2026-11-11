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
  },
  {
    version: 8,
    name: 'ai-analysis-jobs-results-and-evidence',
    up(db) {
      // M6: a manual AI round trip is tracked as a job (one session, one
      // prompt version, one or more batches). A result is always stored with
      // the exact package/batch it answers and is never merged into the raw
      // event tables. Evidence references are recorded separately so the UI can
      // say truthfully when the source message no longer exists.
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_jobs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
          broadcaster_id TEXT,
          kind TEXT NOT NULL DEFAULT 'session_analysis',
          locale TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          protocol_version TEXT NOT NULL,
          batch_total INTEGER NOT NULL DEFAULT 1,
          max_messages INTEGER NOT NULL DEFAULT 1000,
          total_messages INTEGER NOT NULL DEFAULT 0,
          legacy INTEGER NOT NULL DEFAULT 0,
          aggregate_package_id TEXT,
          aggregate_task_id TEXT,
          last_error_at INTEGER,
          last_error_code TEXT,
          last_error_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ai_jobs_session
          ON ai_jobs (session_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS ai_job_batches (
          job_id TEXT NOT NULL REFERENCES ai_jobs (id) ON DELETE CASCADE,
          batch_index INTEGER NOT NULL,
          batch_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          from_seq INTEGER NOT NULL,
          to_seq INTEGER NOT NULL,
          from_at INTEGER,
          to_at INTEGER,
          message_count INTEGER NOT NULL,
          checksum TEXT NOT NULL,
          package_id TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (job_id, batch_index),
          UNIQUE (job_id, batch_id)
        );

        -- seq -> real event id. This is the authoritative traceability map for
        -- every message a package contained; an AI result can only cite these.
        CREATE TABLE IF NOT EXISTS ai_job_messages (
          job_id TEXT NOT NULL,
          batch_index INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          event_id INTEGER NOT NULL,
          PRIMARY KEY (job_id, batch_index, seq),
          FOREIGN KEY (job_id, batch_index)
            REFERENCES ai_job_batches (job_id, batch_index) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_job_messages_event
          ON ai_job_messages (job_id, event_id);

        -- Stable viewer identities included in one batch's viewer_context.json.
        -- Imported viewer profiles must resolve to one of these, never to a
        -- nickname and never to another broadcaster's identity.
        CREATE TABLE IF NOT EXISTS ai_job_viewers (
          job_id TEXT NOT NULL,
          batch_index INTEGER NOT NULL,
          viewer_id TEXT NOT NULL,
          PRIMARY KEY (job_id, batch_index, viewer_id),
          FOREIGN KEY (job_id, batch_index)
            REFERENCES ai_job_batches (job_id, batch_index) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS ai_results (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES ai_jobs (id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
          scope_key TEXT NOT NULL,
          batch_index INTEGER,
          task_id TEXT NOT NULL,
          task_kind TEXT NOT NULL,
          protocol_version TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          locale TEXT NOT NULL,
          checksum TEXT NOT NULL,
          result_version INTEGER NOT NULL,
          source TEXT NOT NULL,
          result_json TEXT NOT NULL,
          evidence_total INTEGER NOT NULL DEFAULT 0,
          evidence_missing INTEGER NOT NULL DEFAULT 0,
          imported_at INTEGER NOT NULL,
          UNIQUE (job_id, scope_key, checksum)
        );

        CREATE INDEX IF NOT EXISTS idx_ai_results_job
          ON ai_results (job_id, scope_key, result_version DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_results_session
          ON ai_results (session_id, imported_at DESC);

        CREATE TABLE IF NOT EXISTS ai_result_evidence (
          result_id TEXT NOT NULL REFERENCES ai_results (id) ON DELETE CASCADE,
          section TEXT NOT NULL,
          item_index INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          batch_index INTEGER NOT NULL,
          event_id INTEGER,
          available INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (result_id, section, item_index, batch_index, seq)
        );

        CREATE INDEX IF NOT EXISTS idx_ai_result_evidence_event
          ON ai_result_evidence (event_id);
      `);

      // Package rows gain provenance. Existing rows keep NULL / defaults and
      // remain valid (they are pre-M6 single exports).
      db.exec('ALTER TABLE ai_packages ADD COLUMN job_id TEXT');
      db.exec('ALTER TABLE ai_packages ADD COLUMN batch_index INTEGER');
      db.exec("ALTER TABLE ai_packages ADD COLUMN stage TEXT NOT NULL DEFAULT 'single'");
      db.exec('ALTER TABLE ai_packages ADD COLUMN prompt_version TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_ai_packages_job ON ai_packages (job_id, batch_index)');
    }
  },
  {
    version: 9,
    name: 'session-platform-live-status',
    up(db) {
      // Platform state is a separate axis from the local capture state. A
      // WebSocket can stay connected after the streamer stops; `status='live'`
      // must therefore never be used as "the broadcast is still live".
      //
      // platform_status: live / ended / not_started / carousel / unknown / ending
      // platform_status_at: when that state was last observed/confirmed
      // last_live_seen_at: last reliable confirmation that the room was live
      // platform_ended_at: best platform-side end time; NULL when unknown
      // platform_end_quality: event / poll / unknown
      db.exec('ALTER TABLE sessions ADD COLUMN platform_status TEXT');
      db.exec('ALTER TABLE sessions ADD COLUMN platform_status_at INTEGER');
      db.exec('ALTER TABLE sessions ADD COLUMN last_live_seen_at INTEGER');
      db.exec('ALTER TABLE sessions ADD COLUMN platform_ended_at INTEGER');
      db.exec('ALTER TABLE sessions ADD COLUMN platform_end_quality TEXT');
      // Old rows stay NULL on purpose: there is no honest way to infer whether
      // a historic broadcast ended, is still live, or was stopped by the user.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_platform_status
          ON sessions (platform, platform_status, started_at DESC);
      `);
    }
  },
  {
    version: 10,
    name: 'long-term-viewer-memory',
    up(db) {
      // M7: long-term viewer memory.
      //
      // Every memory is scoped to exactly one `broadcaster × viewer` pair. The
      // same platform account seen in two channels therefore has two completely
      // independent memories; nothing is shared or merged across channels.
      //
      // The head row keeps the current version pointer. Atomic knowledge lives
      // in `memory_facts`, one row per fact, with:
      //   certainty: stated (the viewer said it) / inferred (AI guess) /
      //              uncertain (cannot be confirmed)
      //   status:    active / outdated / conflicted / superseded /
      //              needs_confirmation
      // AI output can never move an inference into "stated" on its own, and a
      // fact is never silently deleted because a new export disagreed with it.
      db.exec(`
        CREATE TABLE IF NOT EXISTS viewer_memories (
          id TEXT PRIMARY KEY,
          broadcaster_id TEXT NOT NULL REFERENCES broadcasters (id) ON DELETE CASCADE,
          viewer_id TEXT NOT NULL REFERENCES viewers (id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
          version INTEGER NOT NULL DEFAULT 0,
          summary TEXT,
          summary_certainty TEXT,
          first_memory_at INTEGER NOT NULL,
          last_update_at INTEGER NOT NULL,
          last_session_id TEXT,
          last_job_id TEXT,
          deleted_at INTEGER,
          delete_reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (broadcaster_id, viewer_id)
        );

        CREATE INDEX IF NOT EXISTS idx_viewer_memories_broadcaster
          ON viewer_memories (broadcaster_id, last_update_at DESC);
        CREATE INDEX IF NOT EXISTS idx_viewer_memories_viewer
          ON viewer_memories (viewer_id);

        CREATE TABLE IF NOT EXISTS memory_facts (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL REFERENCES viewer_memories (id) ON DELETE CASCADE,
          broadcaster_id TEXT NOT NULL,
          viewer_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          topic TEXT,
          statement TEXT NOT NULL,
          certainty TEXT NOT NULL,
          status TEXT NOT NULL,
          status_reason TEXT,
          confidence REAL,
          dedupe_key TEXT NOT NULL,
          evidence_status TEXT NOT NULL DEFAULT 'none',
          evidence_count INTEGER NOT NULL DEFAULT 0,
          evidence_available INTEGER NOT NULL DEFAULT 0,
          source_kind TEXT NOT NULL,
          source_session_id TEXT,
          source_job_id TEXT,
          source_result_id TEXT,
          source_label TEXT,
          valid_from INTEGER,
          valid_until INTEGER,
          superseded_by TEXT,
          conflicts_with TEXT,
          user_verified INTEGER NOT NULL DEFAULT 0,
          first_seen_at INTEGER NOT NULL,
          last_confirmed_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- Only one *live* fact per topic. Superseded rows deliberately leave the
        -- index so a state change ("preparing for an exam" -> "exam is over")
        -- can keep its history while the new state reuses the same topic key.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_facts_dedupe
          ON memory_facts (memory_id, dedupe_key)
          WHERE status <> 'superseded';
        CREATE INDEX IF NOT EXISTS idx_memory_facts_memory
          ON memory_facts (memory_id, status, kind);

        CREATE TABLE IF NOT EXISTS memory_fact_evidence (
          fact_id TEXT NOT NULL REFERENCES memory_facts (id) ON DELETE CASCADE,
          source_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          batch_index INTEGER,
          seq INTEGER,
          event_id INTEGER,
          observed_at INTEGER,
          available INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (fact_id, source_key)
        );

        CREATE INDEX IF NOT EXISTS idx_memory_evidence_event
          ON memory_fact_evidence (event_id);
        CREATE INDEX IF NOT EXISTS idx_memory_evidence_session
          ON memory_fact_evidence (session_id);

        -- Append-only memory versions. snapshot_json holds the full fact set
        -- of that version so any earlier state can be restored; diff_json
        -- records what actually changed, which is what the UI shows.
        CREATE TABLE IF NOT EXISTS memory_versions (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL REFERENCES viewer_memories (id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          source_kind TEXT NOT NULL,
          source_job_id TEXT,
          source_result_id TEXT,
          source_session_id TEXT,
          source_key TEXT NOT NULL,
          counts_json TEXT NOT NULL,
          diff_json TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          applied_at INTEGER NOT NULL,
          UNIQUE (memory_id, version)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_versions_source
          ON memory_versions (memory_id, source_key);
        CREATE INDEX IF NOT EXISTS idx_memory_versions_applied
          ON memory_versions (memory_id, applied_at DESC);

        -- A memory update job always belongs to one session: that session is
        -- the "new information" being merged into the existing memories.
        CREATE TABLE IF NOT EXISTS memory_jobs (
          id TEXT PRIMARY KEY,
          broadcaster_id TEXT,
          session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
          locale TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          protocol_version TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'session',
          batch_total INTEGER NOT NULL DEFAULT 1,
          viewers_total INTEGER NOT NULL DEFAULT 0,
          messages_total INTEGER NOT NULL DEFAULT 0,
          last_error_at INTEGER,
          last_error_code TEXT,
          last_error_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_memory_jobs_session
          ON memory_jobs (session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_jobs_broadcaster
          ON memory_jobs (broadcaster_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS memory_job_batches (
          job_id TEXT NOT NULL REFERENCES memory_jobs (id) ON DELETE CASCADE,
          batch_index INTEGER NOT NULL,
          batch_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          viewer_count INTEGER NOT NULL DEFAULT 0,
          message_count INTEGER NOT NULL DEFAULT 0,
          checksum TEXT NOT NULL,
          file_name TEXT,
          bytes INTEGER,
          package_checksum TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (job_id, batch_index),
          UNIQUE (job_id, batch_id)
        );

        -- seq -> real event id inside one batch. An imported memory update may
        -- only cite (batch, seq) pairs that exist here, so invented sources are
        -- rejected instead of being stored as evidence.
        CREATE TABLE IF NOT EXISTS memory_job_messages (
          job_id TEXT NOT NULL,
          batch_index INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          event_id INTEGER NOT NULL,
          PRIMARY KEY (job_id, batch_index, seq),
          FOREIGN KEY (job_id, batch_index)
            REFERENCES memory_job_batches (job_id, batch_index) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS memory_job_viewers (
          job_id TEXT NOT NULL,
          batch_index INTEGER NOT NULL,
          viewer_id TEXT NOT NULL,
          base_memory_id TEXT,
          base_version INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (job_id, batch_index, viewer_id),
          FOREIGN KEY (job_id, batch_index)
            REFERENCES memory_job_batches (job_id, batch_index) ON DELETE CASCADE
        );

        -- One applied AI answer per (job, batch, checksum). Re-importing the
        -- identical answer is a no-op; a different answer for an already
        -- applied batch needs an explicit new version.
        CREATE TABLE IF NOT EXISTS memory_results (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES memory_jobs (id) ON DELETE CASCADE,
          session_id TEXT NOT NULL,
          batch_index INTEGER NOT NULL,
          batch_id TEXT NOT NULL,
          checksum TEXT NOT NULL,
          protocol_version TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          locale TEXT NOT NULL,
          source TEXT NOT NULL,
          result_json TEXT NOT NULL,
          viewer_total INTEGER NOT NULL DEFAULT 0,
          op_total INTEGER NOT NULL DEFAULT 0,
          evidence_total INTEGER NOT NULL DEFAULT 0,
          evidence_missing INTEGER NOT NULL DEFAULT 0,
          applied_at INTEGER NOT NULL,
          UNIQUE (job_id, batch_id, checksum)
        );

        CREATE INDEX IF NOT EXISTS idx_memory_results_job
          ON memory_results (job_id, batch_index);
      `);
    }
  },
  {
    version: 11,
    name: 'persistent-monitor-targets',
    up(db) {
      // Automatic live monitoring: a persistent target is the room/channel the
      // user follows, not one broadcast. It survives the end of a stream; every
      // new broadcast creates a normal `sessions` row linked back to the target.
      //
      // `state` is the monitoring lifecycle (waiting / checking / connecting /
      // recording / ending / paused / error). The capture connection state is
      // NOT copied here: it stays on the recording/adapter so a network
      // reconnect can never be mistaken for a new broadcast.
      db.exec(`
        CREATE TABLE IF NOT EXISTS monitor_targets (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          target_key TEXT NOT NULL,
          display_name TEXT,
          input TEXT,
          broadcaster_id TEXT,
          platform_uid TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          state TEXT NOT NULL DEFAULT 'waiting',
          next_check_at INTEGER,
          last_check_at INTEGER,
          last_live_at INTEGER,
          last_session_id TEXT,
          active_session_id TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          last_error_code TEXT,
          last_error_at INTEGER,
          paused_at INTEGER,
          meta_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (platform, target_key)
        );

        CREATE INDEX IF NOT EXISTS idx_monitor_targets_next
          ON monitor_targets (enabled, state, next_check_at);
        CREATE INDEX IF NOT EXISTS idx_monitor_targets_broadcaster
          ON monitor_targets (broadcaster_id, updated_at DESC);

        ALTER TABLE sessions ADD COLUMN monitor_target_id TEXT;

        CREATE INDEX IF NOT EXISTS idx_sessions_monitor_target
          ON sessions (monitor_target_id, started_at DESC);
      `);
    }
  },
  {
    version: 12,
    name: 'unified-analysis-memory-coverage',
    up(db) {
      // One AI analysis task now updates the session report and long-term
      // viewer memory together. These tables record, per job, exactly which
      // viewer was assigned to which analysis batch, which stable status that
      // viewer reached, and the seq -> event mapping for the viewer excerpts.
      //
      // They deliberately reference `ai_jobs`/`ai_job_batches`, not a second
      // memory job: a removal of the analysis job also removes its coverage.
      db.exec(`
        ALTER TABLE ai_jobs ADD COLUMN memory_viewers_total INTEGER NOT NULL DEFAULT 0;

        CREATE TABLE IF NOT EXISTS ai_job_memory_viewers (
          job_id TEXT NOT NULL,
          viewer_id TEXT NOT NULL,
          batch_index INTEGER NOT NULL,
          base_memory_id TEXT,
          base_version INTEGER NOT NULL DEFAULT 0,
          message_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          result_id TEXT,
          processed_at INTEGER,
          PRIMARY KEY (job_id, viewer_id),
          FOREIGN KEY (job_id, batch_index)
            REFERENCES ai_job_batches (job_id, batch_index) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_job_memory_viewers_batch
          ON ai_job_memory_viewers (job_id, batch_index, status);
        CREATE INDEX IF NOT EXISTS idx_ai_job_memory_viewers_viewer
          ON ai_job_memory_viewers (viewer_id, processed_at DESC);

        -- Memory evidence uses a seq local to the viewer excerpts in one batch.
        -- The viewer_id column lets validation prove that a cited message was
        -- actually written by the viewer whose memory is being changed.
        CREATE TABLE IF NOT EXISTS ai_job_memory_messages (
          job_id TEXT NOT NULL,
          batch_index INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          viewer_id TEXT NOT NULL,
          event_id INTEGER NOT NULL,
          PRIMARY KEY (job_id, batch_index, seq),
          FOREIGN KEY (job_id, batch_index)
            REFERENCES ai_job_batches (job_id, batch_index) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_job_memory_messages_event
          ON ai_job_memory_messages (job_id, event_id);
        CREATE INDEX IF NOT EXISTS idx_ai_job_memory_messages_viewer
          ON ai_job_memory_messages (job_id, viewer_id);

        -- Existing imported results keep working: their memory coverage is
        -- derived lazily from ai_job_viewers (objective update only).
      `);
    }
  },
  {
    version: 13,
    name: 'split-session-analysis-and-viewer-memory',
    up(db) {
      // v0.13.0 separates the single-session report from long-term viewer
      // memory. Old jobs keep `combined` so historical reports remain readable.
      // Provider details are a snapshot on the job: changing the default config
      // later must not rewrite what an in-flight task is actually using.
      db.exec("ALTER TABLE ai_jobs ADD COLUMN analysis_mode TEXT NOT NULL DEFAULT 'combined'");
      db.exec('ALTER TABLE ai_jobs ADD COLUMN provider_config_id TEXT');
      db.exec('ALTER TABLE ai_jobs ADD COLUMN provider_id TEXT');
      db.exec('ALTER TABLE ai_jobs ADD COLUMN region_id TEXT');
      db.exec('ALTER TABLE ai_jobs ADD COLUMN model_id TEXT');
      db.exec('ALTER TABLE ai_jobs ADD COLUMN pricing_status TEXT');
      db.exec('ALTER TABLE ai_jobs ADD COLUMN budget_json TEXT');
      db.exec('ALTER TABLE ai_jobs ADD COLUMN cost_estimate_json TEXT');
      db.exec('ALTER TABLE ai_jobs ADD COLUMN usage_json TEXT');
      db.exec('ALTER TABLE ai_jobs ADD COLUMN requested_by TEXT');
      db.exec("ALTER TABLE ai_results ADD COLUMN analysis_mode TEXT NOT NULL DEFAULT 'combined'");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_ai_jobs_mode
          ON ai_jobs (session_id, analysis_mode, created_at DESC);
      `);
      // Capability results are an audit trail. The effective capability set is
      // also stored on the config, but this table records what was tested,
      // against which model/region and when, even after a config is deleted.
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_provider_tests (
          id TEXT PRIMARY KEY,
          config_id TEXT,
          provider_id TEXT NOT NULL,
          region_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          status TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          stages_json TEXT NOT NULL,
          duration_ms INTEGER,
          tested_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_provider_tests_config
          ON ai_provider_tests (config_id, tested_at DESC);
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

import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {openDatabase, closeDatabase} from '../src/storage/database/connection.mjs';
import {migrate} from '../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../src/platforms/shared/session-manager.mjs';
import {TikTokService} from '../src/platforms/tiktok/service.mjs';
import {TikTokClient} from '../src/platforms/tiktok/client.mjs';
import {TikTokSigner} from '../src/platforms/tiktok/signer.mjs';
import {getSession} from '../src/storage/repositories/sessions.mjs';

/**
 * Long-running real TikTok LIVE soak test.
 *
 * Usage: node scripts/verify-tiktok-live-30m.mjs [handle] [minutes]
 *
 * It uses an isolated SQLite database under tests/.tmp and the free community
 * signer. No mock frames are inserted. The script waits for the first real
 * message, then measures a continuous window (default 30 minutes), recording:
 *   - connection/interruption/rate-limit states;
 *   - last successful poll and last real event times;
 *   - SQLite chat count, stable `tiktok:<id>` identities, msgId uniqueness;
 *   - whether any reconnection happened and why.
 *
 * It does not print chat bodies. The report is written to the artifact folder.
 */

const handle = String(process.argv[2] ?? 'aljazeeraenglish').replace(/^@/, '');
const minutes = Math.max(1, Number(process.argv[3] ?? 30));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = resolve('tests', '.tmp', `verify-tiktok-live-${stamp}`);
mkdirSync(root, {recursive: true});
const dbFile = join(root, 'data', 'database', 'livememory.db');
mkdirSync(join(root, 'data', 'database'), {recursive: true});

const db = openDatabase({file: dbFile});
migrate(db, {now: Date.now()});

const logger = {
  info: (entry) => process.stdout.write(`INFO ${JSON.stringify(entry)}\n`),
  warn: (entry) => process.stdout.write(`WARN ${JSON.stringify(entry)}\n`),
  error: (entry) => process.stdout.write(`ERROR ${JSON.stringify(entry)}\n`)
};

const now = Date.now;
const settings = {get: () => ({storageMode: 'compact', tiktokTransport: 'signer'})};
const sessionManager = new SessionManager({db, settings, logger, now});
const client = new TikTokClient({now});
const signer = new TikTokSigner({now});
const service = new TikTokService({
  sessionManager,
  db,
  settings,
  logger,
  now,
  client,
  signer,
  adapterOptions: {
    // Keep the transport responsive while still respecting the shared budget.
    pollIntervalMs: 15000,
    statusIntervalMs: 120000,
    watchdogCheckMs: 30000,
    watchdogMs: 180000
  }
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function snapshot(sessionId = null) {
  const status = service.status();
  const recording = sessionId
    ? status.recordings.find((item) => item.sessionId === sessionId) ?? null
    : status.recordings.at(-1) ?? null;
  const row = sessionId ? getSession(db, sessionId) : null;
  return {
    at: Date.now(),
    transport: status.transport,
    rateLimit: status.rateLimit,
    sessionId,
    connection: recording?.connection?.state ?? 'none',
    capture: recording?.capture ?? null,
    messageCount: Number(row?.message_count ?? 0),
    uniqueViewers: Number(row?.unique_viewer_count ?? 0)
  };
}

async function waitFor(check, {timeoutMs = 10 * 60 * 1000, intervalMs = 5000, label = 'condition'} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const states = new Set();
const transitions = [];
let sessionId = null;
let firstEventAt = null;
let captureStartedAt = null;
let captureEndedAt = null;
let lastSnapshot = null;

try {
  const room = await service.checkRoom(handle);
  logger.info({event: 'soak.room', uniqueId: room.uniqueId, roomId: room.roomId, isLive: room.isLive, title: room.title});
  if (!room.isLive) throw new Error('room is not live; choose a live TikTok handle');

  const started = await service.connect(handle);
  sessionId = started.session.id;
  logger.info({
    event: 'soak.connected',
    sessionId,
    connection: started.connection?.state,
    transport: started.connection?.transport
  });

  // Wait for the first real event, but keep polling the status while the first
  // batch may be delayed by the anonymous hourly pacing.
  firstEventAt = await waitFor(() => {
    const current = snapshot(sessionId);
    lastSnapshot = current;
    states.add(current.connection);
    if (current.capture?.lastEventAt) return current.capture.lastEventAt;
    if (current.connection === 'rate_limited') {
      logger.warn({event: 'soak.rate_limited', retryInMs: current.capture?.retryInMs, rateLimit: current.rateLimit});
    }
    return null;
  }, {timeoutMs: 12 * 60 * 1000, label: 'first real event'});
  logger.info({event: 'soak.first_event', firstEventAt, messageCount: snapshot(sessionId).messageCount});

  captureStartedAt = Date.now();
  const captureDeadline = captureStartedAt + minutes * 60 * 1000;
  while (Date.now() < captureDeadline) {
    const current = snapshot(sessionId);
    lastSnapshot = current;
    if (!states.has(current.connection)) states.add(current.connection);
    transitions.push({
      at: current.at,
      connection: current.connection,
      category: current.capture?.category ?? null,
      attempt: current.capture?.attempt ?? null,
      lastEventAt: current.capture?.lastEventAt ?? null,
      reconnects: current.capture?.reconnectAttempts ?? 0,
      rateLimit: current.rateLimit
    });
    logger.info({
      event: 'soak.tick',
      elapsedSec: Math.round((Date.now() - captureStartedAt) / 1000),
      connection: current.connection,
      category: current.capture?.category ?? null,
      messages: current.messageCount,
      viewers: current.uniqueViewers,
      lastEventAt: current.capture?.lastEventAt ?? null,
      reconnects: current.capture?.reconnectAttempts ?? 0,
      rateLimited: current.connection === 'rate_limited'
    });
    await sleep(30000);
  }
  captureEndedAt = Date.now();
} catch (error) {
  logger.error({event: 'soak.failure', message: String(error?.message ?? error)});
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try {
      await service.disconnect({sessionId});
    } catch (error) {
      logger.warn({event: 'soak.stop.failed', message: String(error?.message ?? error)});
    }
  }
  await service.shutdown().catch(() => {});
  await sessionManager.shutdown().catch(() => {});

  const row = sessionId ? getSession(db, sessionId) : null;
  const eventRows = sessionId
    ? db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN viewer_uid IS NOT NULL AND viewer_uid <> '' THEN 1 ELSE 0 END) AS with_uid,
             SUM(CASE WHEN external_id IS NOT NULL AND external_id <> '' THEN 1 ELSE 0 END) AS with_external,
             COUNT(DISTINCT external_id) AS distinct_external,
             SUM(CASE WHEN content IS NOT NULL AND content <> '' THEN 1 ELSE 0 END) AS with_content
        FROM events WHERE session_id = ?
    `).get(sessionId)
    : null;
  const nonAscii = sessionId
    ? db.prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND content IS NOT NULL AND content <> '' AND content GLOB '*[^ -~]*'`).get(sessionId)
    : null;
  const report = {
    handle,
    minutes,
    sessionId,
    captureStartedAt,
    captureEndedAt,
    captureDurationMs: captureStartedAt && captureEndedAt ? captureEndedAt - captureStartedAt : null,
    firstEventAt,
    lastSnapshot,
    states: [...states],
    rateLimitedDuringWindow: transitions.some((item) => item.connection === 'rate_limited'),
    reconnectAttempts: Math.max(0, ...transitions.map((item) => item.reconnects ?? 0), 0),
    session: row ? {
      status: row.status,
      messageCount: row.message_count,
      uniqueViewerCount: row.unique_viewer_count,
      endReason: row.end_reason
    } : null,
    events: eventRows ? {
      total: Number(eventRows.total ?? 0),
      withUid: Number(eventRows.with_uid ?? 0),
      withExternalId: Number(eventRows.with_external ?? 0),
      distinctExternalId: Number(eventRows.distinct_external ?? 0),
      withContent: Number(eventRows.with_content ?? 0),
      nonAsciiContent: Number(nonAscii?.n ?? 0)
    } : null,
    transitions
  };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  logger.info({event: 'soak.report', path: join(root, 'report.json'), report});
  closeDatabase(db);
  process.stdout.write(`\nRESULT ${process.exitCode ? 'FAILED' : 'COMPLETED'}\n`);
  process.stdout.write(`artifacts: ${root}\n`);
}

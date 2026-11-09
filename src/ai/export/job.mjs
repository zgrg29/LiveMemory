import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildSessionSummary} from '../../analytics/sessions/summary.mjs';
import {
  countSessionMessages,
  listSessionMessagesAsc
} from '../../storage/repositories/events.mjs';
import {getSessionViewersByIds, listSessionViewers} from '../../storage/repositories/viewers.mjs';
import {insertPackage, listPackages} from '../../storage/repositories/ai-packages.mjs';
import {setSessionAiStatus} from '../../storage/repositories/sessions.mjs';
import {
  clearJobFailure,
  insertJob,
  insertJobBatch,
  insertJobMessages,
  insertJobViewers,
  listAllJobViewerIds,
  listJobBatches,
  listJobs,
  setJobAggregatePackage
} from '../../storage/repositories/ai-jobs.mjs';
import {latestResultForScope, listResults} from '../../storage/repositories/ai-results.mjs';
import {recomputeSessionAiStatus} from '../tasks/status.mjs';
import {withTransaction} from '../../storage/database/connection.mjs';
import {createZip} from '../../shared/zip.mjs';
import {createId} from '../../shared/ids.mjs';
import {isoFromEpochMs} from '../../shared/time.mjs';
import {APP_NAME, APP_VERSION} from '../../shared/app-info.mjs';
import {buildInstructions} from '../prompts/instructions.mjs';
import {
  ANALYSIS_PROTOCOL,
  DEFAULT_BATCH_MESSAGES,
  MAX_ANALYSIS_MESSAGES,
  MAX_BATCH_MESSAGES,
  MIN_BATCH_MESSAGES,
  RESULT_PROTOCOL,
  RESULT_SCHEMA_VERSION,
  TASK_KIND,
  aggregateTaskId,
  batchTaskId,
  promptVersionFor
} from '../constants.mjs';
import {
  PACKAGE_NOTES,
  buildMessageLines,
  buildSessionContextBlock,
  buildViewerContextList
} from './context.mjs';

const SCHEMA_FILE = fileURLToPath(new URL('../schemas/analysis-result-v1.schema.json', import.meta.url));

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function timestampForFile(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function safeFilePart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40);
}

export function normalizeBatchSize(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_BATCH_MESSAGES;
  return Math.min(MAX_BATCH_MESSAGES, Math.max(MIN_BATCH_MESSAGES, Math.trunc(number)));
}

function contentFile(name, data) {
  const buffer = Buffer.from(data, 'utf8');
  return {name, data: buffer, bytes: buffer.length, sha256: sha256(buffer)};
}

async function readSchemaText() {
  return readFile(SCHEMA_FILE, 'utf8');
}

/**
 * Build a versioned analysis job and export every batch package.
 *
 * Messages are split on message boundaries in (occurred_at, id) order. Every
 * batch records the exact seq → event row mapping and the viewer identities it
 * contains, so an AI answer can only cite messages and viewers that really were
 * in that batch. A job of one batch is complete on its own; two or more batches
 * additionally need the stage-2 aggregate package.
 */
export async function createAnalysisJob({
  db,
  sessionId,
  locale = 'en',
  exportsDir,
  batchSize = DEFAULT_BATCH_MESSAGES,
  now = Date.now()
}) {
  const summary = buildSessionSummary(db, sessionId, {now});
  if (!summary) return null;
  const session = summary.session;
  const totalMessages = countSessionMessages(db, session.id);
  if (totalMessages === 0) return null;
  if (totalMessages > MAX_ANALYSIS_MESSAGES) {
    throw Object.assign(new Error('ANALYSIS_TOO_LARGE'), {
      code: 'ANALYSIS_TOO_LARGE',
      totalMessages,
      limit: MAX_ANALYSIS_MESSAGES
    });
  }
  const messagesPerBatch = normalizeBatchSize(batchSize);
  const batchTotal = Math.max(1, Math.ceil(totalMessages / messagesPerBatch));
  const jobId = createId('aij');
  const promptVersion = promptVersionFor(locale);
  const schemaText = await readSchemaText();
  const allViewers = listSessionViewers(db, session.id, {limit: 2000});
  const viewersById = new Map(allViewers.map((viewer) => [viewer.viewer_id, viewer]));
  const createdAt = new Date(now);
  const writtenFiles = [];
  const packages = [];

  try {
    await mkdir(exportsDir, {recursive: true});
    for (let index = 1; index <= batchTotal; index += 1) {
      const offset = (index - 1) * messagesPerBatch;
      const messages = listSessionMessagesAsc(db, {
        sessionId: session.id,
        limit: messagesPerBatch,
        offset
      });
      if (messages.length === 0) {
        throw Object.assign(new Error('ANALYSIS_SESSION_CHANGED'), {
          code: 'ANALYSIS_SESSION_CHANGED',
          batchIndex: index
        });
      }
      const batchId = `${jobId}-b${pad(index)}`;
      const taskId = batchTaskId(session.id, index, batchTotal);
      const {lines, emoteEntries, messagesWithEmotes} = buildMessageLines({messages, session, locale});
      const messagesData = lines.length ? `${lines.join('\n')}\n` : '';
      const messagesFile = contentFile('messages.jsonl', messagesData);

      const batchViewerIds = new Set(messages.map((message) => message.viewer_id).filter(Boolean));
      const missingViewerIds = [...batchViewerIds].filter((viewerId) => !viewersById.has(viewerId));
      if (missingViewerIds.length > 0) {
        for (const viewer of getSessionViewersByIds(db, session.id, missingViewerIds)) {
          viewersById.set(viewer.viewer_id, viewer);
        }
      }
      const batchViewers = [...batchViewerIds].map((id) => viewersById.get(id)).filter(Boolean);
      const viewerContext = buildViewerContextList({
        db,
        viewers: batchViewers,
        broadcasterId: session.broadcasterId ?? null
      });

      const fromAt = messages[0].occurred_at;
      const toAt = messages[messages.length - 1].occurred_at;
      const coverage = {
        from_seq: offset + 1,
        to_seq: offset + messages.length,
        message_count: messages.length,
        from_at: isoFromEpochMs(fromAt),
        to_at: isoFromEpochMs(toAt)
      };
      const baseContext = buildSessionContextBlock(summary);
      const sessionContext = {
        protocol: ANALYSIS_PROTOCOL,
        generated_at: isoFromEpochMs(now),
        ...baseContext,
        job: {
          id: jobId,
          prompt_version: promptVersion,
          locale,
          schema_version: RESULT_SCHEMA_VERSION
        },
        batch: {
          index,
          total: batchTotal,
          batch_id: batchId,
          task_id: taskId,
          ...coverage
        },
        batch_coverage: coverage,
        emote_dictionary: emoteEntries.length > 0 ? emoteEntries : undefined,
        counts: {
          messages_in_package: messages.length,
          messages_total: totalMessages,
          messages_with_emotes: messagesWithEmotes,
          emote_kinds: emoteEntries.length,
          viewers: viewerContext.length,
          events: summary.stats.eventCount
        },
        notes: {
          ...PACKAGE_NOTES,
          batch_scope: `This package contains messages ${offset + 1}–${offset + messages.length} of ${totalMessages}. It is a partial analysis of one batch, not the whole broadcast.`
        }
      };

      const manifest = {
        protocol: ANALYSIS_PROTOCOL,
        result_protocol: RESULT_PROTOCOL,
        schema_version: RESULT_SCHEMA_VERSION,
        created_at: isoFromEpochMs(now),
        app: {name: APP_NAME, version: APP_VERSION},
        locale,
        prompt_version: promptVersion,
        session_id: session.id,
        platform: session.platform,
        broadcaster_id: session.broadcasterId ?? null,
        broadcaster_identity: session.broadcasterIdentity ?? 'unresolved',
        simulated: session.simulated,
        job_id: jobId,
        stage: 'batch',
        batch: {
          index,
          total: batchTotal,
          batch_id: batchId,
          from_seq: coverage.from_seq,
          to_seq: coverage.to_seq,
          message_count: messages.length,
          from_at: coverage.from_at,
          to_at: coverage.to_at,
          checksum: messagesFile.sha256
        },
        coverage: {
          ...coverage,
          messages_total: totalMessages
        },
        tasks: [{task_id: taskId, kind: TASK_KIND.SESSION_ANALYSIS, session_id: session.id}],
        counts: {
          messages: messages.length,
          viewers: viewerContext.length,
          events: summary.stats.eventCount,
          messages_with_emotes: messagesWithEmotes,
          emote_kinds: emoteEntries.length
        },
        files: []
      };

      const instructions = buildInstructions(locale, {
        session: {
          id: session.id,
          platform: session.platform,
          simulated: session.simulated,
          started_at: session.startedAt,
          ended_at: session.endedAt
        },
        broadcaster: baseContext.broadcaster,
        messageCount: messages.length,
        messagesWithEmotes,
        emoteCount: emoteEntries.length,
        support: summary.support,
        jobId,
        taskId,
        promptVersion,
        batch: {index, total: batchTotal, batchId, fromSeq: coverage.from_seq, toSeq: coverage.to_seq, messageCount: messages.length, fromAt, toAt}
      });

      const contentFiles = [
        contentFile('session_context.json', `${JSON.stringify(sessionContext, null, 2)}\n`),
        messagesFile,
        contentFile('viewer_context.json', `${JSON.stringify(viewerContext, null, 2)}\n`),
        contentFile('instructions.md', instructions.endsWith('\n') ? instructions : `${instructions}\n`),
        contentFile('result.schema.json', schemaText)
      ];
      manifest.files = contentFiles.map((file) => ({name: file.name, bytes: file.bytes, sha256: file.sha256}));
      const files = [
        {name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n`},
        ...contentFiles.map((file) => ({name: file.name, data: file.data}))
      ];
      const archive = createZip(files);
      const fileName = `LiveMemory-Analysis-${safeFilePart(session.id.slice(-8))}-${safeFilePart(jobId.slice(-6))}-b${pad(index)}of${pad(batchTotal)}-${timestampForFile(createdAt)}-${locale}.zip`;
      const absolutePath = join(exportsDir, fileName);
      await writeFile(absolutePath, archive);
      writtenFiles.push(absolutePath);

      packages.push({
        batchIndex: index,
        batchId,
        taskId,
        fileName,
        absolutePath,
        bytes: archive.length,
        packageChecksum: sha256(archive),
        messagesChecksum: messagesFile.sha256,
        fromSeq: coverage.from_seq,
        toSeq: coverage.to_seq,
        fromAt,
        toAt,
        messageCount: messages.length,
        viewerCount: viewerContext.length,
        messagesWithEmotes,
        emoteKinds: emoteEntries.length,
        messages,
        viewerIds: [...batchViewerIds]
      });
    }

    const result = withTransaction(db, () => {
      insertJob(db, {
        id: jobId,
        sessionId: session.id,
        broadcasterId: session.broadcasterId ?? null,
        locale,
        promptVersion,
        protocolVersion: ANALYSIS_PROTOCOL,
        batchTotal,
        maxMessages: messagesPerBatch,
        totalMessages,
        aggregateTaskId: batchTotal > 1 ? aggregateTaskId(session.id) : null,
        createdAt: now
      });
      for (const entry of packages) {
        const packageId = createId('pkg');
        entry.packageId = packageId;
        insertPackage(db, {
          id: packageId,
          sessionId: session.id,
          kind: 'analysis',
          protocolVersion: ANALYSIS_PROTOCOL,
          locale,
          fileName: entry.fileName,
          relativePath: entry.fileName,
          checksum: entry.packageChecksum,
          messageCount: entry.messageCount,
          jobId,
          batchIndex: entry.batchIndex,
          stage: 'batch',
          promptVersion,
          createdAt: now
        });
        insertJobBatch(db, {
          jobId,
          batchIndex: entry.batchIndex,
          batchId: entry.batchId,
          taskId: entry.taskId,
          fromSeq: entry.fromSeq,
          toSeq: entry.toSeq,
          fromAt: entry.fromAt,
          toAt: entry.toAt,
          messageCount: entry.messageCount,
          checksum: entry.messagesChecksum,
          packageId,
          createdAt: now
        });
        insertJobMessages(db, jobId, entry.batchIndex, entry.messages.map((message, index) => ({
          seq: index + 1,
          eventId: message.id
        })));
        insertJobViewers(db, jobId, entry.batchIndex, entry.viewerIds);
      }
      recomputeSessionAiStatus(db, session.id, {setSessionAiStatus, listJobs, now});
      return true;
    });
    void result;

    return {
      job: {
        id: jobId,
        sessionId: session.id,
        locale,
        promptVersion,
        protocolVersion: ANALYSIS_PROTOCOL,
        batchTotal,
        maxMessages: messagesPerBatch,
        totalMessages,
        createdAt: now
      },
      packages: packages.map((entry) => ({
        id: entry.packageId,
        stage: 'batch',
        batchIndex: entry.batchIndex,
        batchId: entry.batchId,
        taskId: entry.taskId,
        fileName: entry.fileName,
        bytes: entry.bytes,
        messageCount: entry.messageCount,
        fromSeq: entry.fromSeq,
        toSeq: entry.toSeq,
        fromAt: entry.fromAt,
        toAt: entry.toAt,
        checksum: entry.packageChecksum,
        messagesChecksum: entry.messagesChecksum,
        viewerCount: entry.viewerCount
      }))
    };
  } catch (error) {
    for (const file of writtenFiles) {
      await rm(file, {force: true}).catch(() => {});
    }
    throw error;
  }
}

/**
 * Stage 2: one aggregate package containing the validated per-batch results.
 * It deliberately contains no raw messages — the AI merges already-validated
 * results and returns the final session-wide JSON.
 */
export async function buildAggregatePackage({
  db,
  jobId,
  exportsDir,
  now = Date.now()
}) {
  const job = db.prepare('SELECT * FROM ai_jobs WHERE id = ?').get(String(jobId));
  if (!job) return null;
  if (Number(job.batch_total) < 2) {
    const error = new Error('AGGREGATE_NOT_REQUIRED');
    error.code = 'AGGREGATE_NOT_REQUIRED';
    throw error;
  }
  const batches = listJobBatches(db, jobId);
  const results = listResults(db, jobId, {includeJson: true});
  const latestByBatch = new Map();
  for (const result of results) {
    if (result.batchIndex !== null) latestByBatch.set(result.batchIndex, result);
  }
  const missing = batches.filter((batch) => !latestByBatch.has(batch.batchIndex)).map((batch) => batch.batchIndex);
  if (missing.length > 0) {
    const error = new Error('AGGREGATE_BATCHES_MISSING');
    error.code = 'AGGREGATE_BATCHES_MISSING';
    error.missing = missing;
    throw error;
  }

  const summary = buildSessionSummary(db, job.session_id, {now});
  if (!summary) return null;
  const session = summary.session;
  const schemaText = await readSchemaText();
  const baseContext = buildSessionContextBlock(summary);
  const allViewers = listSessionViewers(db, session.id, {limit: 2000});
  const includedViewerIds = new Set(listAllJobViewerIds(db, jobId));
  const viewersById = new Map(allViewers.map((viewer) => [viewer.viewer_id, viewer]));
  const missingViewerIds = [...includedViewerIds].filter((viewerId) => !viewersById.has(viewerId));
  if (missingViewerIds.length > 0) {
    for (const viewer of getSessionViewersByIds(db, session.id, missingViewerIds)) {
      viewersById.set(viewer.viewer_id, viewer);
    }
  }
  const viewerContext = buildViewerContextList({
    db,
    viewers: [...includedViewerIds].sort().map((viewerId) => viewersById.get(viewerId)).filter(Boolean),
    broadcasterId: session.broadcasterId ?? null
  });
  const taskId = job.aggregate_task_id || aggregateTaskId(session.id);
  const batchResults = batches.map((batch) => {
    const result = latestByBatch.get(batch.batchIndex);
    return {
      batch_id: batch.batchId,
      batch_index: batch.batchIndex,
      task_id: batch.taskId,
      coverage: {
        from_seq: batch.fromSeq,
        to_seq: batch.toSeq,
        message_count: batch.messageCount,
        from_at: batch.fromAt ? isoFromEpochMs(batch.fromAt) : null,
        to_at: batch.toAt ? isoFromEpochMs(batch.toAt) : null
      },
      result_version: result.resultVersion,
      imported_at: isoFromEpochMs(result.importedAt),
      result: result.result
    };
  });
  const firstBatch = batches[0];
  const lastBatch = batches[batches.length - 1];
  const coverage = {
    from_seq: firstBatch?.fromSeq ?? 1,
    to_seq: lastBatch?.toSeq ?? 0,
    message_count: Number(job.total_messages ?? 0),
    from_at: firstBatch?.fromAt ? isoFromEpochMs(firstBatch.fromAt) : null,
    to_at: lastBatch?.toAt ? isoFromEpochMs(lastBatch.toAt) : null
  };
  const locale = job.locale;
  const promptVersion = job.prompt_version;

  const sessionContext = {
    protocol: ANALYSIS_PROTOCOL,
    generated_at: isoFromEpochMs(now),
    ...baseContext,
    job: {id: jobId, prompt_version: promptVersion, locale, schema_version: RESULT_SCHEMA_VERSION},
    stage: 'aggregate',
    coverage,
    counts: {
      messages_total: Number(job.total_messages ?? 0),
      batch_total: batches.length,
      batch_results: batchResults.length,
      viewers: viewerContext.length,
      events: summary.stats.eventCount
    },
    notes: {
      ...PACKAGE_NOTES,
      aggregate_scope: 'This is the stage-2 aggregate package. It contains validated batch results, not raw messages. Merge them into one final session-wide result and cite evidence as {batch, seq}.'
    }
  };

  const instructions = buildInstructions(locale, {
    session: {
      id: session.id,
      platform: session.platform,
      simulated: session.simulated,
      started_at: session.startedAt,
      ended_at: session.endedAt
    },
    broadcaster: baseContext.broadcaster,
    messageCount: Number(job.total_messages ?? 0),
    support: summary.support,
    jobId,
    taskId,
    promptVersion,
    aggregate: {batchCount: batches.length}
  });

  const manifest = {
    protocol: ANALYSIS_PROTOCOL,
    result_protocol: RESULT_PROTOCOL,
    schema_version: RESULT_SCHEMA_VERSION,
    created_at: isoFromEpochMs(now),
    app: {name: APP_NAME, version: APP_VERSION},
    locale,
    prompt_version: promptVersion,
    session_id: session.id,
    platform: session.platform,
    broadcaster_id: session.broadcasterId ?? null,
    broadcaster_identity: session.broadcasterIdentity ?? 'unresolved',
    simulated: session.simulated,
    job_id: jobId,
    stage: 'aggregate',
    coverage: {...coverage, batch_total: batches.length},
    tasks: [{task_id: taskId, kind: TASK_KIND.SESSION_AGGREGATE, session_id: session.id}],
    batch_results: batchResults.map((entry) => ({
      batch_id: entry.batch_id,
      batch_index: entry.batch_index,
      result_version: entry.result_version,
      from_seq: entry.coverage.from_seq,
      to_seq: entry.coverage.to_seq
    })),
    counts: {
      messages: Number(job.total_messages ?? 0),
      batches: batches.length,
      viewers: viewerContext.length,
      events: summary.stats.eventCount
    },
    files: []
  };

  const contentFiles = [
    contentFile('session_context.json', `${JSON.stringify(sessionContext, null, 2)}\n`),
    contentFile('viewer_context.json', `${JSON.stringify(viewerContext, null, 2)}\n`),
    contentFile('batch_results.json', `${JSON.stringify(batchResults, null, 2)}\n`),
    contentFile('instructions.md', instructions.endsWith('\n') ? instructions : `${instructions}\n`),
    contentFile('result.schema.json', schemaText)
  ];
  manifest.files = contentFiles.map((file) => ({name: file.name, bytes: file.bytes, sha256: file.sha256}));
  const files = [
    {name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n`},
    ...contentFiles.map((file) => ({name: file.name, data: file.data}))
  ];
  const archive = createZip(files);
  const fileName = `LiveMemory-Analysis-${safeFilePart(session.id.slice(-8))}-${safeFilePart(jobId.slice(-6))}-aggregate-${timestampForFile(new Date(now))}-${locale}.zip`;
  await mkdir(exportsDir, {recursive: true});
  const absolutePath = join(exportsDir, fileName);
  // Write the file first so a failed filesystem write cannot leave a package row
  // pointing at a file that does not exist. The row is removed if the DB part
  // fails.
  await writeFile(absolutePath, archive);
  let transactionResult;
  try {
    transactionResult = withTransaction(db, () => {
      const packageId = createId('pkg');
      insertPackage(db, {
        id: packageId,
        sessionId: session.id,
        kind: 'analysis',
        protocolVersion: ANALYSIS_PROTOCOL,
        locale,
        fileName,
        relativePath: fileName,
        checksum: sha256(archive),
        messageCount: Number(job.total_messages ?? 0),
        jobId,
        batchIndex: null,
        stage: 'aggregate',
        promptVersion,
        createdAt: now
      });
      setJobAggregatePackage(db, jobId, {packageId, taskId, now});
      clearJobFailure(db, jobId, {now});
      return {packageId};
    });
  } catch (error) {
    await rm(absolutePath, {force: true}).catch(() => {});
    throw error;
  }

  return {
    id: transactionResult.packageId,
    jobId,
    taskId,
    stage: 'aggregate',
    fileName,
    absolutePath,
    bytes: archive.length,
    checksum: sha256(archive),
    messageCount: Number(job.total_messages ?? 0),
    batchCount: batches.length,
    createdAt: now
  };
}

export function listJobPackages(db, jobId) {
  return listPackages(db, {jobId});
}

/** Exposed for the import validator: the latest result version per batch. */
export function latestBatchResults(db, jobId) {
  const results = listResults(db, jobId);
  const map = new Map();
  for (const result of results) {
    if (result.batchIndex !== null) map.set(result.batchIndex, result);
  }
  return map;
}

export function latestFinalResult(db, jobId) {
  return latestResultForScope(db, jobId, 'final');
}

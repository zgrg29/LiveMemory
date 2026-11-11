import {readFile, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildSessionSummary} from '../../analytics/sessions/summary.mjs';
import {countSessionMessages, listSessionMessagesAsc} from '../../storage/repositories/events.mjs';
import {listSessionViewers} from '../../storage/repositories/viewers.mjs';
import {insertPackage} from '../../storage/repositories/ai-packages.mjs';
import {setSessionAiStatus} from '../../storage/repositories/sessions.mjs';
import {
  insertJob,
  insertJobBatch,
  insertJobMemoryMessages,
  insertJobMemoryViewers,
  insertJobMessages,
  insertJobViewers,
  listJobs
} from '../../storage/repositories/ai-jobs.mjs';
import {recomputeSessionAiStatus} from '../tasks/status.mjs';
import {withTransaction} from '../../storage/database/connection.mjs';
import {createZip} from '../../shared/zip.mjs';
import {createId} from '../../shared/ids.mjs';
import {isoFromEpochMs} from '../../shared/time.mjs';
import {APP_NAME, APP_VERSION} from '../../shared/app-info.mjs';
import {
  ANALYSIS_PROTOCOL,
  ANALYSIS_MODE,
  MAX_ANALYSIS_MESSAGES,
  MAX_ANALYSIS_VIEWERS,
  MAX_MESSAGES_PER_VIEWER_EXCERPT,
  RESULT_PROTOCOL,
  RESULT_SCHEMA_VERSION,
  TASK_KIND,
  promptVersionFor
} from '../constants.mjs';
import {
  PACKAGE_NOTES,
  buildMessageLines,
  buildMemoryPayload,
  buildSessionContextBlock,
  buildViewerContextList
} from './context.mjs';
import {getMemory} from '../../storage/repositories/viewer-memory.mjs';
import {buildSessionInstructions, buildMemoryInstructions} from '../prompts/split.mjs';

const SCHEMA_FILE = fileURLToPath(new URL('../schemas/analysis-result-v1.3.schema.json', import.meta.url));

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

function contentFile(name, data) {
  const buffer = Buffer.from(data, 'utf8');
  return {name, data: buffer, bytes: buffer.length, sha256: sha256(buffer)};
}

async function readSchemaText() {
  return readFile(SCHEMA_FILE, 'utf8');
}

/**
 * Session-only manual package. Deliberately contains no viewer memory context,
 * no viewer excerpts and no per-viewer profile requirement. One file, one JSON
 * answer. The package can still be large; it is significantly smaller than the
 * old combined package because local statistics are included once and long-term
 * memory blobs are omitted.
 */
export async function createSessionAnalysisJob({
  db,
  sessionId,
  locale = 'en',
  exportsDir,
  providerConfigId = null,
  providerId = null,
  regionId = null,
  modelId = null,
  pricingStatus = null,
  budget = null,
  costEstimate = null,
  now = Date.now()
}) {
  const summary = buildSessionSummary(db, sessionId, {now});
  if (!summary) return null;
  const session = summary.session;
  const totalMessages = countSessionMessages(db, session.id);
  if (totalMessages === 0) return null;
  if (totalMessages > MAX_ANALYSIS_MESSAGES) {
    throw Object.assign(new Error('ANALYSIS_TOO_LARGE'), {code: 'ANALYSIS_TOO_LARGE'});
  }
  const allMessages = listSessionMessagesAsc(db, {sessionId: session.id, limit: MAX_ANALYSIS_MESSAGES});
  if (allMessages.length !== totalMessages) {
    throw Object.assign(new Error('ANALYSIS_SESSION_CHANGED'), {code: 'ANALYSIS_SESSION_CHANGED'});
  }
  const participants = listSessionViewers(db, session.id, {limit: MAX_ANALYSIS_VIEWERS + 1});
  if (participants.length > MAX_ANALYSIS_VIEWERS) {
    throw Object.assign(new Error('ANALYSIS_TOO_MANY_VIEWERS'), {code: 'ANALYSIS_TOO_MANY_VIEWERS'});
  }

  const jobId = createId('aij');
  const promptVersion = promptVersionFor(locale, ANALYSIS_MODE.SESSION);
  const batchId = `${jobId}-b01`;
  const taskId = `${session.id}-analysis`;
  const createdAt = new Date(now);
  const {lines, emoteEntries, messagesWithEmotes} = buildMessageLines({messages: allMessages, session, locale});
  const messagesData = lines.length ? `${lines.join('\n')}\n` : '';
  const messagesFile = contentFile('messages.jsonl', messagesData);
  const baseContext = buildSessionContextBlock(summary);
  const schemaText = await readSchemaText();
  const fromAt = allMessages[0]?.occurred_at ?? session.startedAt;
  const toAt = allMessages[allMessages.length - 1]?.occurred_at ?? session.endedAt ?? now;
  const coverage = {
    from_seq: 1,
    to_seq: allMessages.length,
    message_count: allMessages.length,
    from_at: isoFromEpochMs(fromAt),
    to_at: isoFromEpochMs(toAt)
  };
  const sessionContext = {
    protocol: ANALYSIS_PROTOCOL,
    generated_at: isoFromEpochMs(now),
    ...baseContext,
    job: {id: jobId, prompt_version: promptVersion, locale, schema_version: RESULT_SCHEMA_VERSION, analysis_scope: 'session'},
    batch: {index: 1, total: 1, batch_id: batchId, task_id: taskId, ...coverage},
    batch_coverage: coverage,
    counts: {
      messages_in_package: allMessages.length,
      messages_total: totalMessages,
      messages_with_emotes: messagesWithEmotes,
      emote_kinds: emoteEntries.length,
      viewers: participants.length,
      events: summary.stats.eventCount
    },
    notes: {
      ...PACKAGE_NOTES,
      session_only: 'This is a session-only report. Do not produce viewer profiles or long-term memory updates.',
      memory: 'Long-term viewer memory is not part of this task and must not be inferred or returned.'
    }
  };
  const instructions = buildSessionInstructions(locale, {
    session: {
      id: session.id,
      platform: session.platform,
      simulated: session.simulated,
      started_at: session.startedAt,
      ended_at: session.endedAt
    },
    broadcaster: baseContext.broadcaster,
    messageCount: allMessages.length,
    messagesWithEmotes,
    emoteCount: emoteEntries.length,
    support: summary.support,
    jobId,
    taskId,
    batchId,
    promptVersion
  });
  const manifest = {
    protocol: ANALYSIS_PROTOCOL,
    result_protocol: RESULT_PROTOCOL,
    schema_version: RESULT_SCHEMA_VERSION,
    analysis_scope: 'session',
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
    stage: 'session',
    batch: {
      index: 1,
      total: 1,
      batch_id: batchId,
      from_seq: 1,
      to_seq: allMessages.length,
      message_count: allMessages.length,
      from_at: coverage.from_at,
      to_at: coverage.to_at,
      checksum: messagesFile.sha256
    },
    coverage: {...coverage, messages_total: totalMessages},
    tasks: [{task_id: taskId, kind: TASK_KIND.SESSION_ANALYSIS, session_id: session.id}],
    counts: {
      messages: allMessages.length,
      viewers: participants.length,
      events: summary.stats.eventCount,
      messages_with_emotes: messagesWithEmotes,
      emote_kinds: emoteEntries.length
    },
    files: []
  };
  const contentFiles = [
    contentFile('session_context.json', `${JSON.stringify(sessionContext, null, 2)}\n`),
    messagesFile,
    contentFile('instructions.md', instructions.endsWith('\n') ? instructions : `${instructions}\n`),
    contentFile('result.schema.json', schemaText)
  ];
  manifest.files = contentFiles.map((file) => ({name: file.name, bytes: file.bytes, sha256: file.sha256}));
  const archive = createZip([
    {name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n`},
    ...contentFiles
  ]);
  const fileName = `LiveMemory-Session-${safeFilePart(session.id.slice(-8))}-${safeFilePart(jobId.slice(-6))}-${timestampForFile(createdAt)}-${locale}.zip`;
  await mkdir(exportsDir, {recursive: true});
  const absolutePath = join(exportsDir, fileName);
  await writeFile(absolutePath, archive);
  let packageId = null;
  try {
    withTransaction(db, () => {
      insertJob(db, {
        id: jobId,
        sessionId: session.id,
        broadcasterId: session.broadcasterId ?? null,
        kind: TASK_KIND.SESSION_ANALYSIS,
        locale,
        promptVersion,
        protocolVersion: ANALYSIS_PROTOCOL,
        batchTotal: 1,
        maxMessages: allMessages.length,
        totalMessages,
        memoryViewersTotal: 0,
        analysisMode: ANALYSIS_MODE.SESSION,
        providerConfigId,
        providerId,
        regionId,
        modelId,
        pricingStatus,
        budget,
        costEstimate,
        aggregateTaskId: null,
        createdAt: now
      });
      packageId = createId('pkg');
      insertPackage(db, {
        id: packageId,
        sessionId: session.id,
        kind: 'analysis',
        protocolVersion: ANALYSIS_PROTOCOL,
        locale,
        fileName,
        relativePath: fileName,
        checksum: sha256(archive),
        messageCount: allMessages.length,
        jobId,
        batchIndex: 1,
        stage: 'session',
        promptVersion,
        createdAt: now
      });
      insertJobBatch(db, {
        jobId,
        batchIndex: 1,
        batchId,
        taskId,
        fromSeq: 1,
        toSeq: allMessages.length,
        fromAt,
        toAt,
        messageCount: allMessages.length,
        checksum: messagesFile.sha256,
        packageId,
        createdAt: now
      });
      insertJobMessages(db, jobId, 1, allMessages.map((message, index) => ({
        seq: index + 1,
        eventId: message.id
      })));
      insertJobViewers(db, jobId, 1, participants.map((viewer) => viewer.viewer_id));
      recomputeSessionAiStatus(db, session.id, {setSessionAiStatus, listJobs, now});
    });
  } catch (error) {
    await rm(absolutePath, {force: true}).catch(() => {});
    throw error;
  }
  return {
    job: {
      id: jobId,
      sessionId: session.id,
      locale,
      promptVersion,
      analysisMode: ANALYSIS_MODE.SESSION,
      batchTotal: 1,
      totalMessages,
      createdAt: now
    },
    package: {
      id: packageId,
      fileName,
      absolutePath,
      bytes: archive.length,
      stage: 'session',
      batchIndex: 1
    }
  };
}

/**
 * Assign viewers to memory-only batches. A viewer is never split across batches
 * and is never silently dropped when the requested caps are exceeded; the cap
 * is used as a soft load target and the actual batch count grows.
 */
export function assignMemoryOnlyBatches({
  viewers,
  messagesByViewer,
  viewerCap = 10,
  excerptCap = 600,
  maxBatches = 30
}) {
  const batches = [];
  let current = {viewerIds: [], messages: 0};
  const flush = () => {
    if (current.viewerIds.length > 0) {
      batches.push(current);
      current = {viewerIds: [], messages: 0};
    }
  };
  for (const viewer of viewers) {
    const excerptCount = Math.min(
      messagesByViewer.get(viewer.viewer_id)?.length ?? 0,
      MAX_MESSAGES_PER_VIEWER_EXCERPT
    );
    if (current.viewerIds.length >= viewerCap
      || (current.messages + excerptCount > excerptCap && current.viewerIds.length > 0)) {
      flush();
    }
    current.viewerIds.push(viewer.viewer_id);
    current.messages += excerptCount;
  }
  flush();
  if (batches.length > maxBatches) {
    throw Object.assign(new Error('ANALYSIS_TOO_MANY_BATCHES'), {
      code: 'ANALYSIS_TOO_MANY_BATCHES',
      batches: batches.length,
      limit: maxBatches
    });
  }
  return batches;
}

/**
 * Memory-only job. It never writes a session report: results carry only
 * viewer_memory_updates and are excluded from the report reader by
 * `ai_results.analysis_mode`.
 */
export async function createViewerMemoryJob({
  db,
  sessionId,
  locale = 'en',
  exportsDir,
  viewersPerBatch = 10,
  excerptCap = 600,
  maxBatches = 30,
  providerConfigId = null,
  providerId = null,
  regionId = null,
  modelId = null,
  pricingStatus = null,
  budget = null,
  costEstimate = null,
  now = Date.now()
}) {
  const summary = buildSessionSummary(db, sessionId, {now});
  if (!summary) return null;
  const session = summary.session;
  if (!session.broadcasterId) {
    throw Object.assign(new Error('MEMORY_BROADCASTER_REQUIRED'), {code: 'MEMORY_BROADCASTER_REQUIRED'});
  }
  const allViewers = listSessionViewers(db, session.id, {limit: MAX_ANALYSIS_VIEWERS + 1});
  if (allViewers.length === 0) {
    throw Object.assign(new Error('MEMORY_NO_VIEWERS'), {code: 'MEMORY_NO_VIEWERS'});
  }
  if (allViewers.length > MAX_ANALYSIS_VIEWERS) {
    throw Object.assign(new Error('ANALYSIS_TOO_MANY_VIEWERS'), {code: 'ANALYSIS_TOO_MANY_VIEWERS'});
  }
  const allMessages = listSessionMessagesAsc(db, {
    sessionId: session.id,
    limit: MAX_ANALYSIS_MESSAGES
  });
  const messagesByViewer = new Map();
  for (const message of allMessages) {
    if (!message.viewer_id) continue;
    const list = messagesByViewer.get(message.viewer_id) ?? [];
    list.push(message);
    messagesByViewer.set(message.viewer_id, list);
  }
  const batches = assignMemoryOnlyBatches({
    viewers: allViewers,
    messagesByViewer,
    viewerCap: viewersPerBatch,
    excerptCap,
    maxBatches
  });
  const jobId = createId('aij');
  const promptVersion = promptVersionFor(locale, ANALYSIS_MODE.MEMORY);
  const schemaText = await readSchemaText();
  const createdAt = new Date(now);
  const written = [];
  const entries = [];
  const baseContext = buildSessionContextBlock(summary);
  try {
    await mkdir(exportsDir, {recursive: true});
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const batchIndex = index + 1;
      const batchId = `${jobId}-b${pad(batchIndex)}`;
      const taskId = batches.length === 1
        ? `${session.id}-memory`
        : `${session.id}-memory-b${pad(batchIndex)}`;
      const viewerSet = new Set(batch.viewerIds);
      const viewers = allViewers.filter((viewer) => viewerSet.has(viewer.viewer_id));
      const excerptMessages = [];
      for (const viewerId of batch.viewerIds) {
        excerptMessages.push(...(messagesByViewer.get(viewerId) ?? []).slice(-MAX_MESSAGES_PER_VIEWER_EXCERPT));
      }
      excerptMessages.sort((a, b) => a.occurred_at - b.occurred_at || Number(a.id) - Number(b.id));
      const seqByViewer = new Map();
      for (let at = 0; at < excerptMessages.length; at += 1) {
        const viewerId = excerptMessages[at].viewer_id;
        const list = seqByViewer.get(viewerId) ?? [];
        list.push(at + 1);
        seqByViewer.set(viewerId, list);
      }
      const excerptFile = buildMessageLines({messages: excerptMessages, session, locale});
      const excerptContent = contentFile(
        'viewer_excerpts.jsonl',
        excerptFile.lines.length ? `${excerptFile.lines.join('\n')}\n` : ''
      );
      const viewerContext = buildViewerContextList({
        db,
        viewers,
        broadcasterId: session.broadcasterId
      });
      const memoryViewers = viewerContext.map((entry) => ({
        viewer_id: entry.viewer_id,
        platform: entry.platform,
        nickname: entry.nickname,
        evidence_seqs: seqByViewer.get(entry.viewer_id) ?? [],
        session_excerpt_message_count: (seqByViewer.get(entry.viewer_id) ?? []).length,
        zero_excerpt: (seqByViewer.get(entry.viewer_id) ?? []).length === 0,
        memory: buildMemoryPayload(db, {broadcasterId: session.broadcasterId, viewerId: entry.viewer_id})
      }));
      const memoryContext = {
        protocol: ANALYSIS_PROTOCOL,
        kind: 'viewer_memory_only',
        analysis_scope: 'viewer_memory',
        generated_at: isoFromEpochMs(now),
        session: baseContext.session,
        broadcaster: baseContext.broadcaster,
        job: {id: jobId, prompt_version: promptVersion, locale, schema_version: RESULT_SCHEMA_VERSION, analysis_scope: 'viewer_memory'},
        batch: {
          index: batchIndex,
          total: batches.length,
          batch_id: batchId,
          task_id: taskId,
          viewers: memoryViewers.length,
          messages: excerptMessages.length,
          viewers_total: allViewers.length
        },
        viewers: memoryViewers,
        notes: {
          untrusted_content: PACKAGE_NOTES.untrusted_content,
          scope: 'This package is memory-only. Do not output a session report or viewer profiles.',
          authority: 'Only cite seq numbers from viewer_excerpts.jsonl. Evidence must belong to the same viewer_id.',
          coverage: 'Every viewer in memory_context.viewers must have exactly one viewer_memory_updates entry, even with no new information.',
          money: PACKAGE_NOTES.money,
          emoticons: PACKAGE_NOTES.emoticons
        }
      };
      const sessionContext = {
        protocol: ANALYSIS_PROTOCOL,
        generated_at: isoFromEpochMs(now),
        ...baseContext,
        job: {id: jobId, prompt_version: promptVersion, locale, schema_version: RESULT_SCHEMA_VERSION, analysis_scope: 'viewer_memory'},
        batch: {
          index: batchIndex,
          total: batches.length,
          batch_id: batchId,
          task_id: taskId,
          message_count: excerptMessages.length
        },
        counts: {
          viewers_in_batch: memoryViewers.length,
          viewers_total: allViewers.length,
          messages: excerptMessages.length,
          events: summary.stats.eventCount
        },
        notes: {
          ...PACKAGE_NOTES,
          memory_only: 'This task updates long-term viewer memory only. It must not produce a session report.'
        }
      };
      const instructions = buildMemoryInstructions(locale, {
        session: {id: session.id, platform: session.platform, simulated: session.simulated},
        broadcaster: baseContext.broadcaster,
        viewerCount: memoryViewers.length,
        viewersTotal: allViewers.length,
        messageCount: excerptMessages.length,
        jobId,
        taskId,
        batchId,
        promptVersion
      });
      const manifest = {
        protocol: ANALYSIS_PROTOCOL,
        result_protocol: RESULT_PROTOCOL,
        schema_version: RESULT_SCHEMA_VERSION,
        analysis_scope: 'viewer_memory',
        created_at: isoFromEpochMs(now),
        app: {name: APP_NAME, version: APP_VERSION},
        locale,
        prompt_version: promptVersion,
        session_id: session.id,
        platform: session.platform,
        broadcaster_id: session.broadcasterId,
        broadcaster_identity: session.broadcasterIdentity ?? 'unresolved',
        simulated: session.simulated,
        job_id: jobId,
        stage: 'memory',
        batch: {
          index: batchIndex,
          total: batches.length,
          batch_id: batchId,
          message_count: excerptMessages.length
        },
        tasks: [{task_id: taskId, kind: TASK_KIND.VIEWER_MEMORY, session_id: session.id}],
        counts: {
          viewers: memoryViewers.length,
          viewers_total: allViewers.length,
          messages: excerptMessages.length,
          events: summary.stats.eventCount
        },
        files: []
      };
      const contentFiles = [
        contentFile('session_context.json', `${JSON.stringify(sessionContext, null, 2)}\n`),
        contentFile('memory_context.json', `${JSON.stringify(memoryContext, null, 2)}\n`),
        excerptContent,
        contentFile('instructions.md', instructions.endsWith('\n') ? instructions : `${instructions}\n`),
        contentFile('result.schema.json', schemaText)
      ];
      manifest.files = contentFiles.map((file) => ({name: file.name, bytes: file.bytes, sha256: file.sha256}));
      const archive = createZip([
        {name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n`},
        ...contentFiles
      ]);
      const fileName = `LiveMemory-Memory-${safeFilePart(session.id.slice(-8))}-${safeFilePart(jobId.slice(-6))}-b${pad(batchIndex)}of${pad(batches.length)}-${timestampForFile(createdAt)}-${locale}.zip`;
      const absolutePath = join(exportsDir, fileName);
      await writeFile(absolutePath, archive);
      written.push(absolutePath);
      entries.push({
        batchIndex,
        batchId,
        taskId,
        fileName,
        absolutePath,
        archive,
        excerptContent,
        messageCount: excerptMessages.length,
        memoryViewers: memoryViewers.map((viewer) => {
          const memory = getMemory(db, {broadcasterId: session.broadcasterId, viewerId: viewer.viewer_id});
          return {
            viewerId: viewer.viewer_id,
            baseMemoryId: memory?.id ?? null,
            baseVersion: memory?.version ?? 0,
            messageCount: viewer.evidence_seqs.length
          };
        }),
        memoryMessages: excerptMessages.map((message, messageIndex) => ({
          seq: messageIndex + 1,
          viewerId: message.viewer_id,
          eventId: message.id
        })),
        viewerIds: memoryViewers.map((viewer) => viewer.viewer_id)
      });
    }

    withTransaction(db, () => {
      insertJob(db, {
        id: jobId,
        sessionId: session.id,
        broadcasterId: session.broadcasterId,
        kind: TASK_KIND.VIEWER_MEMORY,
        locale,
        promptVersion,
        protocolVersion: ANALYSIS_PROTOCOL,
        batchTotal: entries.length,
        maxMessages: 0,
        totalMessages: allMessages.length,
        memoryViewersTotal: allViewers.length,
        analysisMode: ANALYSIS_MODE.MEMORY,
        providerConfigId,
        providerId,
        regionId,
        modelId,
        pricingStatus,
        budget,
        costEstimate,
        aggregateTaskId: null,
        createdAt: now
      });
      for (const entry of entries) {
        const packageId = createId('pkg');
        entry.packageId = packageId;
        insertPackage(db, {
          id: packageId,
          sessionId: session.id,
          kind: 'memory',
          protocolVersion: ANALYSIS_PROTOCOL,
          locale,
          fileName: entry.fileName,
          relativePath: entry.fileName,
          checksum: sha256(entry.archive),
          messageCount: entry.messageCount,
          jobId,
          batchIndex: entry.batchIndex,
          stage: 'memory',
          promptVersion,
          createdAt: now
        });
        insertJobBatch(db, {
          jobId,
          batchIndex: entry.batchIndex,
          batchId: entry.batchId,
          taskId: entry.taskId,
          fromSeq: 1,
          toSeq: Math.max(0, entry.messageCount),
          fromAt: null,
          toAt: null,
          messageCount: entry.messageCount,
          checksum: entry.excerptContent.sha256,
          packageId,
          createdAt: now
        });
        insertJobViewers(db, jobId, entry.batchIndex, entry.viewerIds);
        insertJobMemoryViewers(db, jobId, entry.memoryViewers.map((viewer) => ({
          ...viewer,
          batchIndex: entry.batchIndex
        })));
        insertJobMemoryMessages(db, jobId, entry.batchIndex, entry.memoryMessages);
      }
      recomputeSessionAiStatus(db, session.id, {setSessionAiStatus, listJobs, now});
    });
    return {
      job: {
        id: jobId,
        sessionId: session.id,
        locale,
        promptVersion,
        analysisMode: ANALYSIS_MODE.MEMORY,
        batchTotal: entries.length,
        memoryViewersTotal: allViewers.length,
        createdAt: now
      },
      packages: entries.map((entry) => ({
        id: entry.packageId,
        batchIndex: entry.batchIndex,
        fileName: entry.fileName,
        stage: 'memory',
        messageCount: entry.messageCount,
        viewerCount: entry.viewerIds.length
      }))
    };
  } catch (error) {
    await Promise.all(written.map((file) => rm(file, {force: true}).catch(() => {})));
    throw error;
  }
}

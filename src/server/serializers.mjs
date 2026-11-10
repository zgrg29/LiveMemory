/** API serializers: database rows (snake_case) -> JSON (camelCase). */
export function serializeEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    sessionId: event.session_id,
    platform: event.platform,
    type: event.event_type,
    viewerId: event.viewer_id,
    displayName: event.display_name,
    occurredAt: event.occurred_at,
    receivedAt: event.received_at,
    content: event.content,
    emotes: Array.isArray(event.emotes) && event.emotes.length > 0 ? event.emotes : [],
    badges: Array.isArray(event.badges) && event.badges.length > 0 ? event.badges : [],
    giftName: event.gift_name,
    giftQuantity: event.gift_quantity,
    amountMinor: event.amount_minor,
    amountDisplay: event.amount_display ?? null,
    currency: event.currency,
    valueKind: event.value_kind,
    isPaid: event.is_paid === true || event.is_paid === 1,
    sourceQuality: event.source_quality
  };
}

export function serializeSessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    platformRoomId: row.platform_room_id,
    roomTitle: row.room_title,
    broadcasterName: row.broadcaster_name,
    broadcasterId: row.broadcaster_id ?? null,
    broadcasterIdentity: row.broadcaster_identity ?? 'unresolved',
    monitorTargetId: row.monitor_target_id ?? null,
    status: row.status,
    endReason: row.end_reason ?? null,
    archived: row.archived_at !== null && row.archived_at !== undefined,
    archivedAt: row.archived_at ?? null,
    storageMode: row.storage_mode,
    sourceQuality: row.source_quality,
    simulated: row.simulated === 1,
    startedAt: row.started_at,
    platformStartedAt: row.platform_started_at ?? null,
    endedAt: row.ended_at,
    lastEventAt: row.last_event_at,
    platformStatus: row.platform_status ?? null,
    platformStatusAt: row.platform_status_at ?? null,
    lastLiveSeenAt: row.last_live_seen_at ?? null,
    platformEndedAt: row.platform_ended_at ?? null,
    platformEndQuality: row.platform_end_quality ?? null,
    messageCount: Number(row.message_count ?? 0),
    giftEventCount: Number(row.gift_event_count ?? 0),
    paymentEventCount: Number(row.payment_event_count ?? 0),
    uniqueViewerCount: Number(row.unique_viewer_count ?? 0),
    eventCount: Number(row.event_count ?? 0),
    aiStatus: row.ai_status
  };
}

export function serializeViewerRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    platformUid: row.platform_uid,
    nickname: row.nickname,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    messageCount: Number(row.message_count ?? 0),
    paymentEventCount: Number(row.payment_event_count ?? 0),
    sessionCount: Number(row.session_count ?? 0),
    nicknameCount: Number(row.nickname_count ?? 0),
    broadcasterCount: Number(row.broadcaster_count ?? 0),
    focused: row.focused === 1
  };
}

export function serializeBroadcasterRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    platformUid: row.platform_uid,
    displayName: row.display_name,
    identity: row.identity_quality,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    sessionCount: Number(row.session_count ?? 0),
    viewerCount: Number(row.viewer_count ?? 0),
    lastSessionAt: row.last_session_at ?? null
  };
}

export function serializePackage(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    protocolVersion: row.protocol_version,
    locale: row.locale,
    fileName: row.file_name,
    checksum: row.checksum,
    messageCount: Number(row.message_count ?? 0),
    jobId: row.job_id ?? null,
    batchIndex: row.batch_index === null || row.batch_index === undefined ? null : Number(row.batch_index),
    stage: row.stage ?? 'single',
    promptVersion: row.prompt_version ?? null,
    createdAt: row.created_at
  };
}

export function serializeJob(row, status = null) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.sessionId ?? row.session_id,
    broadcasterId: row.broadcasterId ?? row.broadcaster_id ?? null,
    kind: row.kind,
    locale: row.locale,
    promptVersion: row.promptVersion ?? row.prompt_version,
    protocolVersion: row.protocolVersion ?? row.protocol_version,
    batchTotal: Number(row.batchTotal ?? row.batch_total ?? 1),
    maxMessages: Number(row.maxMessages ?? row.max_messages ?? 0),
    totalMessages: Number(row.totalMessages ?? row.total_messages ?? 0),
    legacy: Boolean(row.legacy),
    aggregatePackageId: row.aggregatePackageId ?? row.aggregate_package_id ?? null,
    createdAt: Number(row.createdAt ?? row.created_at ?? 0),
    updatedAt: Number(row.updatedAt ?? row.updated_at ?? 0),
    status: status
      ? {
        state: status.status,
        labelKey: status.labelKey,
        complete: status.complete,
        batchesImported: status.batchesImported,
        missingBatches: status.missingBatches,
        aggregateRequired: status.aggregateRequired,
        aggregateImported: status.aggregateImported,
        aggregatePackageReady: status.aggregatePackageReady,
        memoryViewersTotal: status.memoryViewersTotal ?? 0,
        memoryCoverage: status.memoryCoverage ?? null,
        memoryReady: status.memoryReady ?? true,
        versions: status.versions,
        resultCount: status.resultCount,
        latestError: status.latestError
      }
      : null
  };
}

export function serializeBatch(row, packageRow = null) {
  if (!row) return null;
  return {
    batchIndex: Number(row.batchIndex ?? row.batch_index),
    batchId: row.batchId ?? row.batch_id,
    taskId: row.taskId ?? row.task_id,
    fromSeq: Number(row.fromSeq ?? row.from_seq),
    toSeq: Number(row.toSeq ?? row.to_seq),
    fromAt: row.fromAt ?? row.from_at ?? null,
    toAt: row.toAt ?? row.to_at ?? null,
    messageCount: Number(row.messageCount ?? row.message_count),
    checksum: row.checksum,
    packageId: row.packageId ?? row.package_id ?? null,
    package: packageRow ? serializePackage(packageRow) : null
  };
}

export function serializeResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.jobId ?? row.job_id,
    sessionId: row.sessionId ?? row.session_id,
    scopeKey: row.scopeKey ?? row.scope_key,
    batchIndex: row.batchIndex ?? row.batch_index ?? null,
    taskId: row.taskId ?? row.task_id,
    taskKind: row.taskKind ?? row.task_kind,
    protocolVersion: row.protocolVersion ?? row.protocol_version,
    schemaVersion: row.schemaVersion ?? row.schema_version,
    locale: row.locale,
    checksum: row.checksum,
    resultVersion: Number(row.resultVersion ?? row.result_version),
    source: row.source,
    evidenceTotal: Number(row.evidenceTotal ?? row.evidence_total ?? 0),
    evidenceMissing: Number(row.evidenceMissing ?? row.evidence_missing ?? 0),
    importedAt: Number(row.importedAt ?? row.imported_at)
  };
}

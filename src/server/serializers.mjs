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
    giftName: event.gift_name,
    giftQuantity: event.gift_quantity,
    amountMinor: event.amount_minor,
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
    status: row.status,
    storageMode: row.storage_mode,
    sourceQuality: row.source_quality,
    simulated: row.simulated === 1,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastEventAt: row.last_event_at,
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
    focused: row.focused === 1
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
    createdAt: row.created_at
  };
}

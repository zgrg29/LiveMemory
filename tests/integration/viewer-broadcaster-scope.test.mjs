import test from 'node:test';
import assert from 'node:assert/strict';
import {openMemoryDb, addBroadcaster, T0} from '../helpers/ai-fixtures.mjs';
import {createSession} from '../../src/storage/repositories/sessions.mjs';
import {buildViewerProfile} from '../../src/analytics/viewers/profile.mjs';
import {viewerBroadcasters} from '../../src/storage/repositories/broadcasters.mjs';
import {ensureViewer} from '../../src/storage/repositories/viewers.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';

/**
 * A viewer detail page must be scoped to the broadcasters where that stable
 * identity actually interacted. The query is driven by viewer_broadcasters,
 * never by the global broadcaster list.
 */

const B1 = 'youtube:UC_SCOPE_1';
const B2 = 'youtube:UC_SCOPE_2';
const B3 = 'bilibili:9301';
const B4 = 'youtube:UC_SCOPE_4';

function sessionFor(db, broadcasterId, roomId) {
  const platform = broadcasterId.startsWith('bilibili:') ? 'bilibili' : 'youtube';
  return createSession(db, {
    platform,
    platformRoomId: roomId,
    roomTitle: `Room ${roomId}`,
    broadcasterName: `Broadcaster ${roomId}`,
    broadcasterId,
    broadcasterIdentity: 'verified',
    sourceQuality: 'verified',
    startedAt: T0,
    now: T0
  });
}

function chat(ingest, session, {uid, name, at = T0 + 1000, externalId}) {
  ingest.record({
    session_id: session.id,
    platform: session.platform,
    event_type: 'chat',
    viewer_uid: uid,
    display_name: name,
    occurred_at: at,
    content: `hello from ${name}`,
    external_id: externalId
  });
}

function gift(ingest, session, {uid, name, at = T0 + 2000, externalId}) {
  ingest.record({
    session_id: session.id,
    platform: session.platform,
    event_type: 'gift',
    viewer_uid: uid,
    display_name: name,
    occurred_at: at,
    gift_name: 'Rose',
    gift_quantity: 1,
    amount_minor: 100,
    currency: 'CNY',
    value_kind: 'actual',
    is_paid: true,
    external_id: externalId
  });
}

function ids(profile) {
  return (profile.broadcasters ?? []).map((row) => row.id);
}

test('viewer broadcaster options come from actual interactions, including gifts', () => {
  const db = openMemoryDb();
  try {
    addBroadcaster(db, {id: B1, name: 'Scope One', platform: 'youtube'});
    addBroadcaster(db, {id: B2, name: 'Scope Two', platform: 'youtube'});
    addBroadcaster(db, {id: B3, name: 'Scope Three', platform: 'bilibili'});
    addBroadcaster(db, {id: B4, name: 'Scope Four', platform: 'youtube'});
    const s1 = sessionFor(db, B1, 'scope-1');
    const s2 = sessionFor(db, B2, 'scope-2');
    const s3 = sessionFor(db, B3, '9301');
    const s4 = sessionFor(db, B4, 'scope-4');
    const ingest = new EventIngest({db});

    // Single broadcaster: viewer A only appears in B1.
    chat(ingest, s1, {uid: 'UC_A', name: 'Viewer A', externalId: 'a-1'});
    const a = buildViewerProfile(db, 'youtube:UC_A');
    assert.deepEqual(ids(a), [B1]);
    assert.equal(a.viewer.broadcasterCount, 1);

    // Two broadcasters on the same platform: viewer B appears in B1 and B2.
    chat(ingest, s1, {uid: 'UC_B', name: 'Viewer B', externalId: 'b-1', at: T0 + 3000});
    chat(ingest, s2, {uid: 'UC_B', name: 'Viewer B', externalId: 'b-2', at: T0 + 4000});
    const b = buildViewerProfile(db, 'youtube:UC_B');
    assert.deepEqual(new Set(ids(b)), new Set([B1, B2]));
    assert.equal(ids(b).includes(B3), false);

    // Three broadcasters: all related, no global list bleed-through.
    for (const [session, externalId] of [[s1, 'c-1'], [s2, 'c-2'], [s4, 'c-3']]) {
      chat(ingest, session, {uid: 'UC_C', name: 'Viewer C', externalId, at: T0 + 5000});
    }
    const c = buildViewerProfile(db, 'youtube:UC_C');
    assert.deepEqual(new Set(ids(c)), new Set([B1, B2, B4]));

    // Same nickname on another platform/ID is a different viewer with one scope.
    chat(ingest, s1, {uid: 'UC_SAME_NAME', name: 'Same Name', externalId: 'same-1'});
    chat(ingest, s3, {uid: 'SAME_NAME', name: 'Same Name', externalId: 'same-2', at: T0 + 6000});
    const youtubeTwin = buildViewerProfile(db, 'youtube:UC_SAME_NAME');
    const biliTwin = buildViewerProfile(db, 'bilibili:SAME_NAME');
    assert.deepEqual(ids(youtubeTwin), [B1]);
    assert.deepEqual(ids(biliTwin), [B3]);
    assert.notEqual(youtubeTwin.viewer.id, biliTwin.viewer.id);

    // Gift-only viewer: zero chat messages but a real relationship and paid event.
    gift(ingest, s3, {uid: 'GIFT_ONLY', name: 'Gift Only', externalId: 'gift-1'});
    const giftViewer = buildViewerProfile(db, 'bilibili:GIFT_ONLY', {broadcasterId: B3});
    assert.deepEqual(ids(giftViewer), [B3]);
    assert.equal(giftViewer.scope.kind, 'broadcaster');
    assert.equal(giftViewer.scope.messageCount, 0);
    assert.equal(giftViewer.scope.paymentEventCount, 1);
    assert.equal(giftViewer.scope.sessionCount, 1);

    // A viewer with no interactions at all has no broadcaster relationships.
    ensureViewer(db, {
      viewer_id: 'youtube:UC_NOBODY',
      platform: 'youtube',
      viewer_uid: 'UC_NOBODY',
      display_name: 'Nobody',
      occurred_at: T0
    });
    const nobody = buildViewerProfile(db, 'youtube:UC_NOBODY');
    assert.deepEqual(ids(nobody), []);
    assert.equal(nobody.viewer.broadcasterCount, 0);

    // Asking for an unrelated broadcaster must not fabricate a scope.
    const unrelated = buildViewerProfile(db, 'youtube:UC_A', {broadcasterId: B2});
    assert.equal(unrelated.scope.kind, 'none');
    assert.equal(unrelated.scope.broadcaster ?? null, null);
    assert.deepEqual(ids(unrelated), [B1]);

    // The repository itself is the source of truth.
    assert.deepEqual(new Set(viewerBroadcasters(db, 'youtube:UC_B').map((row) => row.broadcaster_id)), new Set([B1, B2]));
  } finally {
    db.close();
  }
});

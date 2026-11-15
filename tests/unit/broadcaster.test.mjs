import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROADCASTER_IDENTITY,
  broadcasterIdentityRank,
  resolveBroadcasterIdentity
} from '../../src/shared/broadcaster.mjs';

test('YouTube broadcaster identity only comes from the channel id, never the video id', () => {
  const verified = resolveBroadcasterIdentity({
    platform: 'youtube',
    platformRoomId: 'some-video-id',
    broadcasterUid: 'UC_CHANNEL_123',
    broadcasterName: 'Channel'
  });
  assert.equal(verified.id, 'youtube:UC_CHANNEL_123');
  assert.equal(verified.identity, BROADCASTER_IDENTITY.VERIFIED);

  const videoOnly = resolveBroadcasterIdentity({
    platform: 'youtube',
    platformRoomId: 'some-video-id',
    broadcasterName: 'Channel'
  });
  assert.equal(videoOnly.id, null);
  assert.equal(videoOnly.identity, BROADCASTER_IDENTITY.UNRESOLVED);
  assert.equal(videoOnly.unresolvedReason, 'youtube_channel_id_missing');
});

test('Bilibili prefers the anchor uid and marks a room-only fallback', () => {
  const verified = resolveBroadcasterIdentity({
    platform: 'bilibili',
    platformRoomId: '5050',
    broadcasterUid: 12345,
    broadcasterName: 'Anchor'
  });
  assert.equal(verified.id, 'bilibili:12345');
  assert.equal(verified.identity, BROADCASTER_IDENTITY.VERIFIED);

  const fallback = resolveBroadcasterIdentity({
    platform: 'bilibili',
    platformRoomId: '5050',
    broadcasterUid: 0,
    broadcasterName: 'Anchor'
  });
  assert.equal(fallback.id, 'bilibili:room:5050');
  assert.equal(fallback.identity, BROADCASTER_IDENTITY.ROOM_FALLBACK);

  const unresolved = resolveBroadcasterIdentity({
    platform: 'bilibili',
    platformRoomId: '',
    broadcasterUid: null
  });
  assert.equal(unresolved.id, null);
  assert.equal(unresolved.identity, BROADCASTER_IDENTITY.UNRESOLVED);
});

test('simulated and unknown platforms never pretend to be a real channel', () => {
  const mock = resolveBroadcasterIdentity({platform: 'mock', platformRoomId: 'simulation'});
  assert.equal(mock.id, 'mock:simulation');
  assert.equal(mock.identity, BROADCASTER_IDENTITY.SIMULATED);
  const generic = resolveBroadcasterIdentity({platform: 'example', broadcasterUid: 'abc'});
  assert.equal(generic.id, 'example:abc');
  assert.equal(generic.identity, BROADCASTER_IDENTITY.VERIFIED);
});

test('identity quality is ordered and control characters are stripped', () => {
  assert.ok(broadcasterIdentityRank('verified') > broadcasterIdentityRank('room_fallback'));
  assert.ok(broadcasterIdentityRank('room_fallback') > broadcasterIdentityRank('simulated'));
  assert.equal(broadcasterIdentityRank('nonsense'), 0);

  const cleaned = resolveBroadcasterIdentity({
    platform: 'youtube',
    broadcasterUid: ' UC_\u0000BAD ',
    broadcasterName: 'Name\u0001'
  });
  assert.equal(cleaned.id, 'youtube:UC_BAD');
  assert.equal(cleaned.displayName, 'Name');
});

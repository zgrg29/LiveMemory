import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KUAISHOU_IDENTITY,
  feedFingerprint,
  mapKuaishouComment,
  parseFeedTimestamp,
  provisionalViewerUid
} from '../../src/platforms/kuaishou/messages.mjs';
import {comment, KUAISHOU_T0} from '../fixtures/kuaishou.mjs';

const context = {
  sessionId: 'ses_test',
  eid: 'abc12345',
  liveStreamId: 'L1',
  receivedAt: KUAISHOU_T0 + 500,
  now: KUAISHOU_T0 + 500
};

test('a Kuaishou comment keeps the original text and a session-scoped provisional identity', () => {
  const feed = comment({userId: 12345, userName: '观众A', content: '原文 🎉 [微笑]', time: KUAISHOU_T0 + 123});
  const {draft, reason, rawUid, timestampSource} = mapKuaishouComment(feed, context);
  assert.equal(reason, null);
  assert.equal(rawUid, '12345');
  assert.equal(timestampSource, 'feed-time');
  assert.equal(draft.platform, 'kuaishou');
  assert.equal(draft.event_type, 'chat');
  assert.equal(draft.content, '原文 🎉 [微笑]');
  assert.equal(draft.display_name, '观众A');
  assert.equal(draft.occurred_at, KUAISHOU_T0 + 123);
  assert.equal(draft.received_at, KUAISHOU_T0 + 500);
  assert.equal(draft.external_id, null, 'the H5 feed has no message id');
  assert.equal(draft.viewer_uid, provisionalViewerUid('ses_test', 12345));
  assert.notEqual(draft.viewer_uid, draft.viewer_uid.replace('@ses_test', '@ses_other'));
  assert.equal(draft.source_quality, 'unknown');
  assert.equal(draft._kuaishou.identityMode, KUAISHOU_IDENTITY.MODE);
  assert.equal(draft._kuaishou.messageId, false);
});

test('the same raw platform id in two sessions never produces the same viewer id', () => {
  const first = mapKuaishouComment(comment({userId: 777}), {...context, sessionId: 'ses_a'}).draft;
  const second = mapKuaishouComment(comment({userId: 777}), {...context, sessionId: 'ses_b'}).draft;
  assert.notEqual(first.viewer_uid, second.viewer_uid);
  assert.match(first.viewer_uid, /^h5:777@ses_a$/);
  assert.match(second.viewer_uid, /^h5:777@ses_b$/);
});

test('a missing or zero user id is not turned into an identity', () => {
  for (const userId of [null, undefined, '', 0, '0']) {
    const raw = {type: 'comment', content: 'x', time: KUAISHOU_T0, author: {userId, userName: 'a'}};
    const draft = mapKuaishouComment(raw, context).draft;
    assert.equal(draft.viewer_uid, null, `userId=${String(userId)}`);
  }
});

test('only comment feeds become chat events; gift and like feeds stay NOT-OBSERVED', () => {
  for (const type of ['gift', 'like', 'enter', 'follow', 'share']) {
    const result = mapKuaishouComment({type, content: 'x', time: KUAISHOU_T0, author: {userId: 1, userName: 'a'}}, context);
    assert.equal(result.draft, null);
    assert.equal(result.reason, `non_chat:${type}`);
  }
  const empty = mapKuaishouComment(comment({content: '   '}), context);
  assert.equal(empty.draft, null);
  assert.equal(empty.reason, 'empty_content');
});

test('timestamps are epoch milliseconds with a conservative fallback', () => {
  assert.deepEqual(parseFeedTimestamp(1700000000123, {now: 1700000001000}), {
    at: 1700000000123,
    source: 'feed-time'
  });
  assert.equal(parseFeedTimestamp(1700000000, {now: 1700000001000}).at, 1700000000000);
  assert.equal(parseFeedTimestamp('1700000000123', {now: 1700000001000}).source, 'feed-time');
  assert.equal(parseFeedTimestamp('not-a-time', {now: 1700000001000}).at, null);
  assert.equal(parseFeedTimestamp(42, {now: 1700000001000}).source, 'out_of_range');
  assert.equal(parseFeedTimestamp(null, {now: 1700000001000}).source, 'missing');

  const fallback = mapKuaishouComment(comment({time: 42}), context).draft;
  assert.equal(fallback.occurred_at, context.receivedAt);
});

test('the duplicate fingerprint is deterministic and includes user, time and content', () => {
  const a = comment({userId: 9, time: 1700000000000, content: 'same'});
  const b = comment({userId: 9, time: 1700000000000, content: 'same'});
  const c = comment({userId: 9, time: 1700000000000, content: 'different'});
  assert.equal(feedFingerprint(a), feedFingerprint(b));
  assert.notEqual(feedFingerprint(a), feedFingerprint(c));
});

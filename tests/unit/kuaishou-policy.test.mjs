import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCollectionAllowed,
  publicAccess,
  resolveKuaishouAccess
} from '../../src/platforms/kuaishou/policy.mjs';
import {KUAISHOU_ERRORS} from '../../src/platforms/kuaishou/errors.mjs';
import {KuaishouService} from '../../src/platforms/kuaishou/service.mjs';

test('live collection is disabled by default and cannot be enabled by one variable alone', () => {
  const byDefault = resolveKuaishouAccess({env: {}});
  assert.equal(byDefault.enabled, false);
  assert.equal(byDefault.authorizationRequired, true);
  assert.equal(byDefault.status, 'authorization-required');

  const optInOnly = resolveKuaishouAccess({env: {LIVEMEMORY_KUAISHOU_H5_OPT_IN: '1'}});
  assert.equal(optInOnly.enabled, false);
  assert.equal(optInOnly.acknowledgementPresent, false);

  const ackOnly = resolveKuaishouAccess({env: {LIVEMEMORY_KUAISHOU_AUTHORIZATION_ACK: 'permit-2026-12'}});
  assert.equal(ackOnly.enabled, false);

  const enabled = resolveKuaishouAccess({
    env: {
      LIVEMEMORY_KUAISHOU_H5_OPT_IN: '1',
      LIVEMEMORY_KUAISHOU_AUTHORIZATION_ACK: 'permit-2026-12'
    }
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.status, 'internal-authorized');
  assert.equal(enabled.authorizationRequired, false);
});

test('the public access projection never exposes the acknowledgement value', () => {
  const access = resolveKuaishouAccess({
    env: {
      LIVEMEMORY_KUAISHOU_H5_OPT_IN: '1',
      LIVEMEMORY_KUAISHOU_AUTHORIZATION_ACK: 'secret-permit-reference'
    }
  });
  const text = JSON.stringify(publicAccess(access));
  assert.doesNotMatch(text, /secret-permit-reference/);
  assert.equal(publicAccess(access).enabled, true);
  assert.equal(publicAccess(resolveKuaishouAccess({env: {}})).enabled, false);
  assert.equal(publicAccess(resolveKuaishouAccess({env: {}})).noticeKey, 'live.source.kuaishouNotice');
});

test('assertCollectionAllowed throws before any request can be made', () => {
  assert.throws(
    () => assertCollectionAllowed({enabled: false}),
    (error) => error.code === KUAISHOU_ERRORS.AUTHORIZATION_REQUIRED && error.httpStatus === 403
  );
  assert.doesNotThrow(() => assertCollectionAllowed({enabled: true}));
});

test('a disabled service parses a link without calling fetch at all', async () => {
  let calls = 0;
  const service = new KuaishouService({
    sessionManager: {listRecordings: () => []},
    access: {enabled: false, status: 'authorization-required', authorizationRequired: true},
    fetchImpl: async () => {
      calls += 1;
      throw new Error('must not fetch');
    }
  });
  const room = await service.checkRoom('https://live.kuaishou.com/u/abc12345');
  assert.equal(room.eid, 'abc12345');
  assert.equal(room.recordable, false);
  assert.equal(room.reason, KUAISHOU_ERRORS.AUTHORIZATION_REQUIRED);
  assert.equal(room.liveStatus, 'unknown');
  assert.equal(calls, 0);
  await assert.rejects(
    () => service.connect('https://live.kuaishou.com/u/abc12345'),
    (error) => error.code === KUAISHOU_ERRORS.AUTHORIZATION_REQUIRED
  );
  assert.equal(calls, 0);
});

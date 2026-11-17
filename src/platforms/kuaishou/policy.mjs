import {KUAISHOU_ERRORS, KuaishouError} from './errors.mjs';

/**
 * Kuaishou access policy.
 *
 * G1 verified that an anonymous H5 feed can return real public chat, but G1.5
 * also established that Kuaishou's own terms forbid robots/spiders from
 * monitoring or copying platform content without written permission, and the H5
 * host's robots.txt disallows every non-whitelisted agent.
 *
 * The product therefore ships the integration with live collection DISABLED.
 * The parsing, storage, analysis, monitoring and UI components remain usable
 * and testable with the saved research samples / simulated data. Real H5
 * polling can only be enabled by an operator who has obtained permission, via
 * BOTH environment variables below. This is an acknowledgement switch, not a
 * way to obtain permission, and the app cannot verify the permission itself.
 *
 *   LIVEMEMORY_KUAISHOU_H5_OPT_IN=1
 *   LIVEMEMORY_KUAISHOU_AUTHORIZATION_ACK=<short internal reference>
 *
 * The acknowledgement value is never logged, returned by the API or written to
 * the database.
 */

export const KUAISHOU_ACCESS_STATUS = Object.freeze({
  AUTHORIZATION_REQUIRED: 'authorization-required',
  INTERNAL_AUTHORIZED: 'internal-authorized'
});

export const KUAISHOU_POLICY = Object.freeze({
  platform: 'kuaishou',
  collectionMode: 'anonymous-h5',
  official: false,
  authorizationRequired: true,
  noticeKey: 'live.source.kuaishouNotice',
  terms: Object.freeze({
    automatedCollection: 'prohibited-without-written-permission',
    robots: 'disallow-all',
    evidence: 'G1.5 legal review'
  }),
  identity: Object.freeze({
    mode: 'session-provisional',
    stableUserId: 'unproven',
    messageId: false
  })
});

const OPT_IN_ENV = 'LIVEMEMORY_KUAISHOU_H5_OPT_IN';
const ACK_ENV = 'LIVEMEMORY_KUAISHOU_AUTHORIZATION_ACK';

/**
 * Resolve the effective access mode.
 *
 * `enabled` is true only when the operator explicitly opts in AND records a
 * non-empty acknowledgement reference. The returned public shape never contains
 * the acknowledgement value.
 */
export function resolveKuaishouAccess({env = process.env} = {}) {
  const optIn = String(env?.[OPT_IN_ENV] ?? '').trim() === '1';
  const ack = String(env?.[ACK_ENV] ?? '').trim();
  const enabled = optIn && ack.length >= 3;
  return {
    enabled,
    status: enabled ? KUAISHOU_ACCESS_STATUS.INTERNAL_AUTHORIZED : KUAISHOU_ACCESS_STATUS.AUTHORIZATION_REQUIRED,
    authorizationRequired: !enabled,
    optIn,
    acknowledgementPresent: ack.length >= 3,
    noticeKey: KUAISHOU_POLICY.noticeKey,
    mode: KUAISHOU_POLICY.collectionMode
  };
}

/** Public, non-sensitive projection used by status/room/connect responses. */
export function publicAccess(access) {
  const enabled = Boolean(access?.enabled);
  return {
    enabled,
    status: enabled
      ? KUAISHOU_ACCESS_STATUS.INTERNAL_AUTHORIZED
      : KUAISHOU_ACCESS_STATUS.AUTHORIZATION_REQUIRED,
    authorizationRequired: !enabled,
    noticeKey: KUAISHOU_POLICY.noticeKey,
    collectionMode: KUAISHOU_POLICY.collectionMode,
    official: false,
    reason: enabled ? null : 'KUAISHOU_WRITTEN_PERMISSION_REQUIRED',
    terms: {...KUAISHOU_POLICY.terms}
  };
}

export function authorizationRequiredError(details = null) {
  return new KuaishouError(KUAISHOU_ERRORS.AUTHORIZATION_REQUIRED, {
    httpStatus: 403,
    messageKey: 'errors.kuaishouAuthorizationRequired',
    details: details ?? {noticeKey: KUAISHOU_POLICY.noticeKey},
    retryable: false
  });
}

/**
 * Throw before any network request when collection is not enabled.
 * Callers must invoke this before resolving a room or opening a feed.
 */
export function assertCollectionAllowed(access) {
  if (!access?.enabled) throw authorizationRequiredError();
  return access;
}

export const __internal = {OPT_IN_ENV, ACK_ENV};

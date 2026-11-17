import {KUAISHOU_ERRORS, KuaishouError, classifyFeedResult} from './errors.mjs';
import {
  KUAISHOU_H5_ORIGIN,
  KUAISHOU_USER_AGENT,
  assertHttpOk,
  requestText
} from './http.mjs';

/**
 * Anonymous H5 feed client.
 *
 * One request = one incremental batch. The adapter owns the polling loop,
 * dedupe and retry policy, so a rate limit or an end-of-broadcast result is
 * visible to the caller instead of being swallowed.
 *
 * This transport is only constructed after `assertCollectionAllowed()` has
 * passed. It performs no login, no cookie import, no browser relay and no
 * signature work; if the platform refuses the request, it fails honestly.
 */
export class KuaishouFeedClient {
  constructor({
    eid,
    liveStreamId,
    fetchImpl = globalThis.fetch,
    userAgent = KUAISHOU_USER_AGENT,
    timeoutMs = 20000
  } = {}) {
    this.eid = String(eid ?? '').trim();
    this.liveStreamId = String(liveStreamId ?? '').trim();
    if (!this.eid || !this.liveStreamId) {
      throw new KuaishouError(KUAISHOU_ERRORS.NOT_CONFIGURED, {
        httpStatus: 503,
        details: {reason: 'eid_or_live_stream_missing'},
        retryable: false
      });
    }
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
  }

  feedUrl(cursor = '') {
    const url = new URL(`${KUAISHOU_H5_ORIGIN}/wap/live/feed`);
    url.searchParams.set('liveStreamId', this.liveStreamId);
    // The G1 probe sent `cursor=` even for the first request.
    url.searchParams.set('cursor', String(cursor ?? ''));
    return url.toString();
  }

  /**
   * @param {string} cursor last cursor, or empty for the first batch
   * @returns {Promise<{feeds:Array, cursor:string, result:number}>}
   */
  async poll(cursor = '') {
    const response = await requestText(this.feedUrl(cursor), {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: {
        'user-agent': this.userAgent,
        accept: 'application/json, text/plain, */*',
        referer: `${KUAISHOU_H5_ORIGIN}/`
      }
    });
    assertHttpOk(response, {what: 'h5-feed'});

    const body = response.json;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new KuaishouError(KUAISHOU_ERRORS.PROTOCOL, {
        details: {reason: 'feed_not_json_object', status: response.status},
        retryable: false
      });
    }
    if (body.result === undefined || body.result === null) {
      throw new KuaishouError(KUAISHOU_ERRORS.PROTOCOL, {
        details: {reason: 'feed_result_missing'},
        retryable: false
      });
    }
    const classified = classifyFeedResult(body.result, body);
    if (classified) throw classified;
    const feeds = Array.isArray(body.liveStreamFeeds) ? body.liveStreamFeeds : [];
    return {
      feeds,
      cursor: body.cursor === undefined || body.cursor === null ? '' : String(body.cursor),
      result: Number(body.result)
    };
  }
}

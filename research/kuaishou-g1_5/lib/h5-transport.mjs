// Kuaishou G1.5 research prototype — anonymous H5 transport.
//
// This route is POLICY-BLOCKED for production: Kuaishou's terms forbid
// monitoring/copying platform content with robot/spider programs, and the H5
// host's robots.txt disallows every non-whitelisted agent. The transport is
// kept so the G1 evidence stays reproducible and so the identity/field logic
// can be unit-tested, but it refuses to run unless the caller explicitly
// acknowledges the block.

import {KuaishouError, CODES, classifyResult, backoffDelay} from './errors.mjs';
import {sleep} from './http.mjs';

const FEED_HOST = 'https://livev.m.chenzhongtech.com';

export const H5_POLICY = Object.freeze({
  blocked: true,
  reason: '快手软件许可及服务协议 禁止以机器人/蜘蛛程序监视、复制平台内容；H5 域名 robots.txt 对 User-agent:* 为 Disallow:/',
  requires: 'acknowledgePolicy: true（仅研究复现，不得进入产品）'
});

export class AnonymousH5Transport {
  #stopped = false;
  #abort = new AbortController();
  #seen = new Set();

  constructor({
    eid,
    liveStreamId,
    intervalMs = 3200,
    maxBackoffMs = 60000,
    maxConsecutiveFailures = 5,
    acknowledgePolicy = false,
    fetchImpl = globalThis.fetch,
    userAgent = 'LiveMemory-Research/0.1 (Kuaishou G1.5; anonymous H5 reproduction)',
    now = Date.now
  } = {}) {
    if (!acknowledgePolicy) {
      throw new KuaishouError(CODES.POLICY_BLOCKED, H5_POLICY.reason, {
        retryable: false,
        detail: {requires: H5_POLICY.requires}
      });
    }
    if (!eid || !liveStreamId) throw new KuaishouError(CODES.CONFIG, 'H5 需要 eid 与 liveStreamId');
    this.eid = eid;
    this.liveStreamId = liveStreamId;
    this.intervalMs = intervalMs;
    this.maxBackoffMs = maxBackoffMs;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.now = now;
    this.cursor = '';
    this.state = 'idle';
    this.stats = {
      polls: 0,
      messages: 0,
      duplicates: 0,
      rateLimited: 0,
      errors: 0,
      reconnects: 0,
      emptyPolls: 0,
      lastResult: null
    };
  }

  get stopped() {
    return this.#stopped;
  }

  async #poll() {
    const url = new URL(`${FEED_HOST}/wap/live/feed`);
    url.searchParams.set('liveStreamId', this.liveStreamId);
    url.searchParams.set('cursor', this.cursor);
    const res = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        'user-agent': this.userAgent,
        accept: 'application/json, text/plain, */*',
        referer: `${FEED_HOST}/`
      },
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) throw new KuaishouError(CODES.HTTP, `H5 feed HTTP ${res.status}`, {retryable: res.status >= 500});
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new KuaishouError(CODES.UPSTREAM, 'H5 feed 不是 JSON');
    }
    return body;
  }

  /**
   * Start the polling loop. `onEvents` receives canonical events; `onStatus`
   * receives {state, ...}. Resolves when stopped or ended.
   */
  async start({onEvents = () => {}, onStatus = () => {}} = {}) {
    this.state = 'live';
    onStatus({state: this.state, eid: this.eid, liveStreamId: this.liveStreamId});
    let failures = 0;

    while (!this.#stopped) {
      try {
        const body = await this.#poll();
        this.stats.polls += 1;
        const result = body?.result;
        this.stats.lastResult = result;
        const err = classifyResult(result, body);
        if (err?.code === CODES.OFFLINE) {
          this.state = 'ended';
          onStatus({state: 'ended', reason: body?.error_msg ?? '直播已停止'});
          break;
        }
        if (err) throw err;

        this.cursor = body?.cursor ?? this.cursor;
        const feeds = Array.isArray(body?.liveStreamFeeds) ? body.liveStreamFeeds : [];
        if (feeds.length === 0) this.stats.emptyPolls += 1;

        for (const feed of feeds) {
          if (feed?.type !== 'comment') continue;
          const author = feed.author ?? {};
          const uid = author.userId == null ? null : String(author.userId);
          const fingerprint = `${uid ?? ''}\u0001${feed.time ?? ''}\u0001${feed.content ?? ''}`;
          if (this.#seen.has(fingerprint)) {
            this.stats.duplicates += 1;
            continue;
          }
          this.#seen.add(fingerprint);
          if (this.#seen.size > 20000) this.#seen.clear();
          this.stats.messages += 1;
          onEvents([{
            type: 'comment',
            id: null,
            principalId: uid,
            nickname: author.userName ?? '',
            content: feed.content ?? '',
            time: feed.time ?? null
          }]);
        }
        failures = 0;
        if (this.state === 'reconnecting') {
          this.state = 'live';
          onStatus({state: 'live', recovered: true});
        }
        await sleep(this.intervalMs, this.#abort.signal);
      } catch (err) {
        if (this.#stopped) break;
        failures += 1;
        this.stats.errors += 1;
        const rateLimited = err?.code === CODES.RATE_LIMITED;
        if (rateLimited) this.stats.rateLimited += 1;
        this.state = rateLimited ? 'rate_limited' : 'reconnecting';
        onStatus({state: this.state, code: err?.code ?? 'NETWORK', attempt: failures});
        if (failures >= this.maxConsecutiveFailures) {
          this.state = 'failed';
          onStatus({state: 'failed', code: err?.code ?? 'NETWORK'});
          throw err;
        }
        try {
          await sleep(backoffDelay(failures - 1, {baseMs: this.intervalMs, maxMs: this.maxBackoffMs}), this.#abort.signal);
        } catch {
          break;
        }
      }
    }
    if (this.state !== 'ended' && this.state !== 'failed') this.state = 'stopped';
    onStatus({state: this.state});
    return this.stats;
  }

  stop() {
    this.#stopped = true;
    this.#abort.abort();
    if (this.state !== 'ended' && this.state !== 'failed') this.state = 'stopped';
  }
}

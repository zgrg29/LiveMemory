/**
 * Per-scope request pacer.
 *
 * Automatic checks of several channels must not leave as a burst. The pacer
 * serializes requests per platform scope and enforces a minimum gap between the
 * end of one request's scheduling slot and the start of the next. It is small on
 * purpose; retry/backoff is the scheduler's job, not the pacer's.
 */
export class RequestPacer {
  constructor({now = Date.now, sleep = defaultSleep, minGapMs = 1500} = {}) {
    this.now = now;
    this.sleep = sleep;
    this.defaultGapMs = Math.max(0, Number(minGapMs) || 0);
    this.lastAt = new Map();
    this.chains = new Map();
  }

  async wait(scope, gapMs = this.defaultGapMs) {
    const key = String(scope ?? 'default');
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.chains.set(key, previous.then(() => current));
    await previous;
    try {
      const last = this.lastAt.get(key);
      const gap = Math.max(0, Number(gapMs) || 0);
      if (last !== undefined) {
        const remaining = last + gap - this.now();
        if (remaining > 0) await this.sleep(remaining);
      }
      this.lastAt.set(key, this.now());
    } finally {
      release();
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

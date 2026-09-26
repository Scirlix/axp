/**
 * Sliding-window limiter for per-minute API credits (Twelve Data's free
 * plan allows 8 per minute). `take(n)` resolves once `n` credits fit in the
 * current 60-second window.
 */
export class CreditLimiter {
  constructor(perMinute, { now = Date.now, sleep = defaultSleep } = {}) {
    this.perMinute = perMinute;
    this.now = now;
    this.sleep = sleep;
    this.spent = []; // [{ at, credits }]
    this.queue = Promise.resolve();
  }

  take(credits) {
    if (credits > this.perMinute) {
      throw new RangeError(`request of ${credits} credits exceeds ${this.perMinute}/min`);
    }
    // Serialise callers so concurrent jobs don't overshoot together.
    const turn = this.queue.then(() => this.#wait(credits));
    this.queue = turn.catch(() => {});
    return turn;
  }

  async #wait(credits) {
    for (;;) {
      const now = this.now();
      this.spent = this.spent.filter((s) => now - s.at < 60_000);
      const used = this.spent.reduce((sum, s) => sum + s.credits, 0);
      if (used + credits <= this.perMinute) {
        this.spent.push({ at: now, credits });
        return;
      }
      await this.sleep(this.spent[0].at + 60_000 - now + 50);
    }
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

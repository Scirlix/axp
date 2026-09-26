import { getInstrument, inCatalogOrder, isForex, isMetal } from './catalog.js';
import { CreditLimiter } from './creditLimiter.js';
import { FrankfurterSource } from './sources/frankfurter.js';
import { GoldApiSource } from './sources/goldApi.js';
import { TwelveDataSource } from './sources/twelveData.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Polls upstream sources on a schedule and keeps the latest quote per symbol
 * in memory. All clients read from this cache, so upstream rate limits don't
 * grow with the number of app users.
 *
 * Only "active" symbols (those on the app's Home or Markets page) are polled;
 * the dashboard changes them at runtime via `setSymbols`.
 */
export class QuoteService {
  /**
   * @param {ReturnType<import('./config.js').loadConfig>} config
   * @param {{ fetchImpl?: typeof fetch, now?: () => number,
   *           limiter?: CreditLimiter }} [deps]
   */
  constructor(config, { fetchImpl = fetch, now = Date.now, limiter } = {}) {
    this.config = config;
    this.now = now;
    this.gold = new GoldApiSource(fetchImpl);
    this.ecb = new FrankfurterSource(fetchImpl);
    this.twelve = config.twelveDataApiKey
      ? new TwelveDataSource(
          config.twelveDataApiKey,
          fetchImpl,
          limiter ?? new CreditLimiter(config.twelveDataCreditsPerMinute),
        )
      : null;

    this.active = [];
    this.started = false;
    this.ticks = new Map(); // symbol -> latest tick
    this.fetchedAt = new Map(); // symbol -> ms of last successful refresh
    this.previousClose = new Map(); // symbol -> reference close
    this.timers = [];
    this.running = new Set();
    /** Last error per job, cleared on success. Exposed on /health. */
    this.lastErrors = {};
  }

  get fx() {
    return this.active.filter(isForex);
  }

  get metals() {
    return this.active.filter(isMetal);
  }

  /** Sets which symbols are polled. New ones are fetched immediately. */
  async setSymbols(symbols) {
    const next = inCatalogOrder(symbols);
    const added = next.filter((s) => !this.active.includes(s));
    this.active = next;
    if (!this.started) return;
    this.#schedule();
    if (added.length) await this.#fetchInitial(added);
  }

  async start(symbols = this.active) {
    this.active = inCatalogOrder(symbols);
    this.started = true;
    await this.#fetchInitial(this.active);
    this.#schedule();
  }

  stop() {
    this.started = false;
    this.#clearTimers();
  }

  /**
   * Brings stale quotes up to date on demand, for hosts where the polling
   * timers cannot run.
   *
   * A serverless function is frozen between requests, so `setInterval` never
   * fires there and prices would be whatever the cold start happened to
   * fetch. Calling this at the top of /v1/quotes refreshes anything past its
   * interval as part of serving the request.
   *
   * Bounded by [timeoutMs]: a slow upstream degrades to slightly stale
   * prices rather than a hanging request. Concurrent callers share the work,
   * because #run skips a job already in flight.
   */
  async ensureFresh({ timeoutMs = 3000 } = {}) {
    if (!this.active.length) return;
    const now = this.now();
    const isStale = (symbol) =>
      (now - (this.fetchedAt.get(symbol) ?? 0)) >= this.#expectedInterval(symbol);

    // Same jobs the timers would have run, picked the same way #schedule
    // picks them, so on-demand and scheduled refreshes behave identically.
    const jobs = [];
    if (this.metals.some(isStale)) {
      jobs.push(this.#run('metals', () => this.#pollMetals()));
    }
    if (this.fx.some(isStale)) {
      jobs.push(
        this.twelve
          ? this.#run('forex', () => this.#pollForexPrices())
          : this.#run('forex', () => this.#pollEcb()),
      );
    }
    if (!jobs.length) return;

    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([Promise.all(jobs), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Forex refresh interval that keeps Twelve Data usage inside the daily
   * credit allowance (10% headroom), after the reference refreshes.
   */
  fxIntervalMs() {
    if (!this.twelve) return HOUR_MS;
    const fxCount = this.fx.length;
    if (fxCount === 0) return null;
    const referencesPerDay = this.active.length * (DAY_MS / this.config.referenceRefreshMs);
    const available = Math.max(this.config.twelveDataCreditsPerDay * 0.9 - referencesPerDay, 1);
    const budgetMs = Math.ceil((fxCount * DAY_MS) / available);
    return Math.max(this.config.fxMinPollMs, budgetMs);
  }

  /** Quotes for every active symbol; `price` is null until the first fetch. */
  snapshot() {
    const now = this.now();
    return this.active.map((symbol) => {
      const { name, category, unit, decimals } = getInstrument(symbol);
      const tick = this.ticks.get(symbol);
      const previousClose = this.previousClose.get(symbol) ?? null;
      const change = tick && previousClose !== null ? tick.price - previousClose : null;
      return {
        symbol,
        name,
        category,
        unit,
        decimals,
        price: tick?.price ?? null,
        previousClose,
        change,
        changePercent: change !== null && previousClose ? (change / previousClose) * 100 : null,
        updatedAt: tick?.updatedAt.toISOString() ?? null,
        source: tick?.source ?? null,
        delayed: tick?.delayed ?? false,
        stale: tick ? now - this.fetchedAt.get(symbol) > this.#expectedInterval(symbol) * 3 : false,
      };
    });
  }

  health() {
    const fxMs = this.fxIntervalMs();
    return {
      forexSource: this.twelve ? TwelveDataSource.NAME : FrankfurterSource.NAME,
      metalsSource: GoldApiSource.NAME,
      activeSymbols: this.active.length,
      forexPollSeconds: fxMs === null ? null : Math.round(fxMs / 1000),
      metalsPollSeconds: Math.round(this.config.metalsPollMs / 1000),
      errors: this.lastErrors,
    };
  }

  // ------------------------------------------------------------------ jobs

  async #fetchInitial(symbols) {
    const fx = symbols.filter(isForex);
    const metals = symbols.filter(isMetal);
    await Promise.all([
      this.#run('forex-init', () => this.#initialForex(fx, symbols), { exclusive: false }),
      metals.length
        ? this.#run('metals-init', () => this.#pollMetals(metals), { exclusive: false })
        : null,
    ]);
  }

  async #initialForex(fx, symbols) {
    if (!this.twelve) return fx.length ? this.#pollEcb(fx) : undefined;
    try {
      // Prices + previous closes for new forex pairs and metals alike.
      await this.#refreshReference(symbols);
    } catch (err) {
      // Keep the app populated while Twelve Data is unavailable.
      if (fx.length) await this.#pollEcb(fx);
      throw err;
    }
  }

  /**
   * Twelve Data /quote: forex prices + previous closes for forex and metals
   * (metal prices themselves come from gold-api).
   */
  async #refreshReference(symbols = this.active) {
    if (!symbols.length) return;
    for (const t of await this.twelve.fetchQuotes(symbols)) {
      if (t.previousClose !== null) this.previousClose.set(t.symbol, t.previousClose);
      if (isForex(t.symbol) || !this.ticks.has(t.symbol)) this.#store(t);
    }
  }

  async #pollForexPrices() {
    const fx = this.fx;
    if (fx.length) (await this.twelve.fetchPrices(fx)).forEach((t) => this.#store(t));
  }

  async #pollEcb(fx = this.fx) {
    if (fx.length) (await this.ecb.fetchRates(fx)).forEach((t) => this.#store(t));
  }

  /** Each metal is fetched on its own so one failure doesn't drop the others. */
  async #pollMetals(metals = this.metals) {
    const results = await Promise.allSettled(metals.map((s) => this.gold.fetchOne(s)));
    const errors = [];
    for (const r of results) {
      if (r.status === 'fulfilled') this.#store(r.value);
      else errors.push(r.reason.message);
    }
    if (errors.length) throw new Error(errors.join('; '));
  }

  // --------------------------------------------------------------- helpers

  #schedule() {
    this.#clearTimers();
    if (this.metals.length) {
      this.#every(this.config.metalsPollMs, 'metals', () => this.#pollMetals());
    }
    const fxMs = this.fxIntervalMs();
    if (this.twelve) {
      if (fxMs !== null) this.#every(fxMs, 'forex', () => this.#pollForexPrices());
      this.#every(this.config.referenceRefreshMs, 'reference', () => this.#refreshReference());
    } else if (this.fx.length) {
      this.#every(HOUR_MS, 'forex', () => this.#pollEcb());
    }
  }

  #store(tick) {
    this.ticks.set(tick.symbol, tick);
    this.fetchedAt.set(tick.symbol, this.now());
    if (tick.previousClose !== null) this.previousClose.set(tick.symbol, tick.previousClose);
  }

  #expectedInterval(symbol) {
    if (isMetal(symbol)) return this.config.metalsPollMs;
    return this.fxIntervalMs() ?? HOUR_MS;
  }

  #every(ms, job, task) {
    const timer = setInterval(() => this.#run(job, task), ms);
    timer.unref(); // don't keep the process alive on its own
    this.timers.push(timer);
  }

  #clearTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /**
   * Runs a job and records failures without crashing the server. Scheduled
   * (exclusive) jobs are skipped while their previous run is still in flight;
   * one-off initial fetches always run.
   */
  async #run(job, task, { exclusive = true } = {}) {
    if (exclusive) {
      if (this.running.has(job)) return;
      this.running.add(job);
    }
    try {
      await task();
      delete this.lastErrors[job];
    } catch (err) {
      this.lastErrors[job] = err.message;
      console.warn(`[quotes] ${job} failed: ${err.message}`);
    } finally {
      if (exclusive) this.running.delete(job);
    }
  }
}

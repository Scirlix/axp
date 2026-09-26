import { getJson, UpstreamError } from '../http.js';

const num = (v) => {
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Real-time forex (and metals reference data) from Twelve Data.
 * Every symbol in a request costs one API credit.
 */
export class TwelveDataSource {
  static NAME = 'Twelve Data';

  /**
   * @param {string} apiKey
   * @param {typeof fetch} [fetchImpl]
   * @param {import('../creditLimiter.js').CreditLimiter} [limiter] keeps
   *   requests within the plan's per-minute credit allowance
   */
  constructor(apiKey, fetchImpl = fetch, limiter = null) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.limiter = limiter;
  }

  /**
   * Full quotes: latest price plus previous close. Used at startup and a few
   * times a day for the daily-change reference.
   */
  async fetchQuotes(symbols) {
    const bySymbol = await this.#get('quote', symbols);
    const ticks = [];
    for (const [symbol, q] of Object.entries(bySymbol)) {
      const price = num(q.close);
      if (price === null) continue;
      const ts = q.last_quote_at ?? q.timestamp;
      ticks.push({
        symbol,
        price,
        previousClose: num(q.previous_close),
        updatedAt: typeof ts === 'number' ? new Date(ts * 1000) : new Date(),
        source: TwelveDataSource.NAME,
        delayed: false,
      });
    }
    return ticks;
  }

  /** Latest prices only (cheapest endpoint) for frequent polling. */
  async fetchPrices(symbols) {
    const bySymbol = await this.#get('price', symbols);
    const now = new Date();
    return Object.entries(bySymbol)
      .map(([symbol, q]) => ({ symbol, price: num(q.price) }))
      .filter((t) => t.price !== null)
      .map((t) => ({
        ...t,
        previousClose: null,
        updatedAt: now,
        source: TwelveDataSource.NAME,
        delayed: false,
      }));
  }

  /** Batches symbols so no single request exceeds the per-minute credits. */
  async #get(endpoint, symbols) {
    const size = this.limiter?.perMinute ?? symbols.length;
    const result = {};
    for (let i = 0; i < symbols.length; i += size) {
      const chunk = symbols.slice(i, i + size);
      await this.limiter?.take(chunk.length);
      Object.assign(result, await this.#getChunk(endpoint, chunk));
    }
    return result;
  }

  async #getChunk(endpoint, symbols) {
    const url = new URL(`https://api.twelvedata.com/${endpoint}`);
    url.searchParams.set('symbol', symbols.join(','));
    url.searchParams.set('apikey', this.apiKey);

    const body = await getJson(this.fetchImpl, TwelveDataSource.NAME, url, 15_000);
    if (body.status === 'error') {
      throw new UpstreamError(TwelveDataSource.NAME, `${body.code}: ${body.message}`);
    }

    // Single-symbol requests return the object itself; batches return a map
    // keyed by symbol. Per-symbol errors are skipped, not fatal.
    const raw = symbols.length === 1 ? { [symbols[0]]: body } : body;
    const result = {};
    for (const [symbol, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue;
      if (value.status === 'error') {
        console.warn(`[${TwelveDataSource.NAME}] ${symbol} skipped: ${value.message}`);
        continue;
      }
      result[symbol] = value;
    }
    return result;
  }
}

import { getJson, UpstreamError } from '../http.js';

/**
 * Fallback forex source: European Central Bank daily reference rates via
 * frankfurter.dev (free, no key). NOT live — published once per business
 * day around 16:00 CET — so every tick is marked `delayed`.
 */
export class FrankfurterSource {
  static NAME = 'ECB reference (daily)';

  constructor(fetchImpl = fetch) {
    this.fetchImpl = fetchImpl;
  }

  /** @param {string[]} symbols e.g. `EUR/USD`, `USD/JPY`, `EUR/GBP` */
  async fetchRates(symbols) {
    const currencies = [...new Set(symbols.flatMap((s) => s.split('/')))].filter(
      (c) => c !== 'USD',
    );

    // A short window guarantees two business days even across weekends and
    // holidays: latest = price, the one before = previous close.
    const from = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const json = await getJson(
      this.fetchImpl,
      FrankfurterSource.NAME,
      `https://api.frankfurter.dev/v1/${from}..?base=USD&symbols=${currencies.join(',')}`,
      15_000,
    );
    const days = Object.keys(json.rates ?? {}).sort();
    if (days.length === 0) throw new UpstreamError(FrankfurterSource.NAME, 'no rates returned');

    const latest = json.rates[days.at(-1)];
    const prior = days.length > 1 ? json.rates[days.at(-2)] : null;
    const publishedAt = new Date(`${days.at(-1)}T14:00:00Z`);

    // Rates are "units of X per 1 USD", so any pair A/B = rate(B) / rate(A);
    // crosses like EUR/GBP work the same way.
    const pairRate = (table, symbol) => {
      if (!table) return null;
      const rate = (c) => (c === 'USD' ? 1 : table[c]);
      const [base, quote] = symbol.split('/');
      const a = rate(base);
      const b = rate(quote);
      return a && b ? b / a : null;
    };

    return symbols
      .map((symbol) => ({
        symbol,
        price: pairRate(latest, symbol),
        previousClose: pairRate(prior, symbol),
        updatedAt: publishedAt,
        source: FrankfurterSource.NAME,
        delayed: true,
      }))
      .filter((t) => t.price !== null);
  }
}

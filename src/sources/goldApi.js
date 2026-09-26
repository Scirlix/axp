import { getJson, UpstreamError } from '../http.js';

/**
 * Live spot metals from gold-api.com (free, no key). USD per troy ounce.
 */
export class GoldApiSource {
  static NAME = 'gold-api.com';

  constructor(fetchImpl = fetch) {
    this.fetchImpl = fetchImpl;
  }

  /** @param {string} symbol like `XAU/USD` */
  async fetchOne(symbol) {
    const asset = symbol.split('/')[0];
    const json = await getJson(
      this.fetchImpl,
      GoldApiSource.NAME,
      `https://api.gold-api.com/price/${asset}`,
    );
    if (typeof json.price !== 'number' || json.currency !== 'USD') {
      throw new UpstreamError(GoldApiSource.NAME, `unexpected payload for ${asset}`);
    }
    const updatedAt = Date.parse(json.updatedAt);
    return {
      symbol,
      price: json.price,
      updatedAt: Number.isNaN(updatedAt) ? new Date() : new Date(updatedAt),
      source: GoldApiSource.NAME,
      delayed: false,
      previousClose: null,
    };
  }
}

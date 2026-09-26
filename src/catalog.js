/**
 * Every instrument the backend knows how to price. The admin dashboard picks
 * which of these appear on the app's Home and Markets pages.
 *
 * - `unit`      contract description shown under the symbol in the app
 * - `decimals`  display precision
 * - forex is priced by Twelve Data (ECB daily rates as fallback);
 *   metals by gold-api.com.
 */
export const CATALOG = [
  // Forex majors
  { symbol: 'EUR/USD', name: 'Euro / US Dollar', category: 'forex', unit: '1 Euro', decimals: 5 },
  { symbol: 'GBP/USD', name: 'British Pound / US Dollar', category: 'forex', unit: '1 GBP', decimals: 5 },
  { symbol: 'USD/JPY', name: 'US Dollar / Japanese Yen', category: 'forex', unit: '1 USD', decimals: 3 },
  { symbol: 'USD/CHF', name: 'US Dollar / Swiss Franc', category: 'forex', unit: '1 USD', decimals: 5 },
  { symbol: 'AUD/USD', name: 'Australian Dollar / US Dollar', category: 'forex', unit: '1 AUD', decimals: 5 },
  { symbol: 'USD/CAD', name: 'US Dollar / Canadian Dollar', category: 'forex', unit: '1 USD', decimals: 5 },
  { symbol: 'NZD/USD', name: 'New Zealand Dollar / US Dollar', category: 'forex', unit: '1 NZD', decimals: 5 },
  // Forex crosses
  { symbol: 'EUR/GBP', name: 'Euro / British Pound', category: 'forex', unit: '1 Euro', decimals: 5 },
  { symbol: 'EUR/JPY', name: 'Euro / Japanese Yen', category: 'forex', unit: '1 Euro', decimals: 3 },
  { symbol: 'GBP/JPY', name: 'British Pound / Japanese Yen', category: 'forex', unit: '1 GBP', decimals: 3 },
  { symbol: 'EUR/CHF', name: 'Euro / Swiss Franc', category: 'forex', unit: '1 Euro', decimals: 5 },
  { symbol: 'AUD/JPY', name: 'Australian Dollar / Japanese Yen', category: 'forex', unit: '1 AUD', decimals: 3 },
  // Metals (USD per troy ounce)
  { symbol: 'XAU/USD', name: 'Gold', category: 'metals', unit: '1 Oz', decimals: 2 },
  { symbol: 'XAG/USD', name: 'Silver', category: 'metals', unit: '1 Oz', decimals: 3 },
  { symbol: 'XPT/USD', name: 'Platinum', category: 'metals', unit: '1 Oz', decimals: 2 },
  { symbol: 'XPD/USD', name: 'Palladium', category: 'metals', unit: '1 Oz', decimals: 2 },
];

const BY_SYMBOL = new Map(CATALOG.map((i) => [i.symbol, i]));

export const getInstrument = (symbol) => BY_SYMBOL.get(symbol);
export const isForex = (symbol) => BY_SYMBOL.get(symbol)?.category === 'forex';
export const isMetal = (symbol) => BY_SYMBOL.get(symbol)?.category === 'metals';

/** Sorts symbols into catalogue order (forex first, then metals). */
export const inCatalogOrder = (symbols) => {
  const wanted = new Set(symbols);
  return CATALOG.filter((i) => wanted.has(i.symbol)).map((i) => i.symbol);
};

/** Matches the app's original design: gold, EUR/USD, GBP/USD on Home. */
export const DEFAULT_LAYOUT = {
  home: ['XAU/USD', 'EUR/USD', 'GBP/USD'],
  markets: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'XAU/USD', 'XAG/USD'],
};

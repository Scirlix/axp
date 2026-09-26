import { DEFAULT_LAYOUT, getInstrument } from './catalog.js';
import { FileStorage } from './storage.js';

export const MAX_HOME = 8;

export class LayoutError extends Error {}

/**
 * Validates a layout from the dashboard. Returns a clean copy or throws
 * LayoutError with a message suitable for showing to the admin.
 */
export function validateLayout(input) {
  if (!input || typeof input !== 'object') throw new LayoutError('Layout must be an object.');
  const clean = {};
  for (const key of ['home', 'markets']) {
    const list = input[key];
    if (!Array.isArray(list)) throw new LayoutError(`"${key}" must be a list of symbols.`);
    const seen = new Set();
    for (const symbol of list) {
      if (typeof symbol !== 'string' || !getInstrument(symbol)) {
        throw new LayoutError(`Unknown instrument in ${key}: ${String(symbol)}`);
      }
      if (seen.has(symbol)) throw new LayoutError(`${symbol} is listed twice in ${key}.`);
      seen.add(symbol);
    }
    clean[key] = [...list];
  }
  if (clean.home.length > MAX_HOME) {
    throw new LayoutError(`Home can show at most ${MAX_HOME} instruments.`);
  }
  return clean;
}

/** Persists the Home / Markets layout as a small JSON file. */
export class LayoutStore {
  /**
   * @param {string|{read,write,description}} storage a file path (local
   *   development) or a backend from storage.js. The indirection is what
   *   lets this keep working on a read-only serverless filesystem.
   */
  constructor(storage) {
    this.storage = typeof storage === 'string' ? new FileStorage(storage) : storage;
    this.layout = structuredClone(DEFAULT_LAYOUT);
  }

  async load() {
    try {
      const stored = await this.storage.read();
      this.layout = stored ? validateLayout(stored) : structuredClone(DEFAULT_LAYOUT);
    } catch (err) {
      console.warn(
        `[layout] ${this.storage.description} unreadable (${err.message}); using defaults`,
      );
      this.layout = structuredClone(DEFAULT_LAYOUT);
    }
    return this.layout;
  }

  async save(input) {
    const layout = validateLayout(input);
    await this.storage.write(layout);
    this.layout = layout;
    return layout;
  }

  /** Every symbol that needs live prices (Home ∪ Markets). */
  activeSymbols() {
    return [...new Set([...this.layout.home, ...this.layout.markets])];
  }
}

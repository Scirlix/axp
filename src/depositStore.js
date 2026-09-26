import { FileStorage } from './storage.js';

export class DepositError extends Error {}

/** Smallest deposit the app will let a user request, in the base currency. */
export const DEFAULT_MIN_AMOUNT = 10;

/**
 * The payment options the app offers, in the order they appear. The admin
 * turns these on and off and supplies a logo; the app never hard-codes them,
 * so a channel can be withdrawn the moment it stops working without shipping
 * a new build.
 */
export const DEFAULT_DEPOSIT = {
  // Where deposit requests are sent. Empty until the admin sets it, which
  // the app treats as "deposits are not open yet".
  whatsappNumber: '',
  minAmount: DEFAULT_MIN_AMOUNT,
  currency: 'USD',
  methods: [
    { id: 'fib', name: 'FIB', logoUrl: '', enabled: true },
    { id: 'qicard', name: 'QI Card', logoUrl: '', enabled: true },
    { id: 'superqi', name: 'Super Qi', logoUrl: '', enabled: true },
    { id: 'zaincash', name: 'ZainCash', logoUrl: '', enabled: true },
    { id: 'fastpay', name: 'FastPay', logoUrl: '', enabled: true },
  ],
};

/** Digits only, the form wa.me links need. `+964 770 222 0011` -> `9647702220011`. */
export function normaliseWhatsApp(raw) {
  return String(raw ?? '').replace(/[^0-9]/g, '');
}

/**
 * Validates deposit settings from the dashboard. Returns a clean copy or
 * throws DepositError with a message suitable for showing to the admin.
 */
export function validateDeposit(input) {
  if (!input || typeof input !== 'object') {
    throw new DepositError('Deposit settings must be an object.');
  }

  const digits = normaliseWhatsApp(input.whatsappNumber);
  // Allowed to be blank — that is how the admin closes deposits entirely.
  if (digits && (digits.length < 8 || digits.length > 15)) {
    throw new DepositError(
      'The WhatsApp number must be 8 to 15 digits, including the country code.',
    );
  }

  const minAmount = Number(input.minAmount);
  if (!Number.isFinite(minAmount) || minAmount <= 0) {
    throw new DepositError('The minimum deposit must be greater than zero.');
  }

  const currency = String(input.currency ?? 'USD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DepositError('Currency must be a three-letter code, e.g. USD.');
  }

  if (!Array.isArray(input.methods) || input.methods.length === 0) {
    throw new DepositError('At least one payment method is required.');
  }

  const seen = new Set();
  const methods = input.methods.map((method) => {
    if (!method || typeof method !== 'object') {
      throw new DepositError('Each payment method must be an object.');
    }
    const id = String(method.id ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,32}$/.test(id)) {
      throw new DepositError(
        `Invalid payment method id: ${String(method.id)}. Use letters, digits, - or _.`,
      );
    }
    if (seen.has(id)) throw new DepositError(`Payment method "${id}" is listed twice.`);
    seen.add(id);

    const name = String(method.name ?? '').trim();
    if (!name) throw new DepositError(`Payment method "${id}" needs a name.`);

    const logoUrl = String(method.logoUrl ?? '').trim();
    // Only http(s): the app renders this straight into an <img>-equivalent,
    // and a data: or javascript: URL has no business there.
    if (logoUrl && !/^https?:\/\//i.test(logoUrl)) {
      throw new DepositError(`The logo for "${name}" must be an http(s) URL.`);
    }

    return { id, name, logoUrl, enabled: Boolean(method.enabled) };
  });

  return { whatsappNumber: digits, minAmount, currency, methods };
}

/** Persists the deposit settings. */
export class DepositStore {
  /**
   * @param {string|{read,write,description}} storage a file path (local
   *   development) or a backend from storage.js.
   */
  constructor(storage) {
    this.storage = typeof storage === 'string' ? new FileStorage(storage) : storage;
    this.settings = structuredClone(DEFAULT_DEPOSIT);
  }

  async load() {
    try {
      const stored = await this.storage.read();
      this.settings = stored
        ? validateDeposit(stored)
        : structuredClone(DEFAULT_DEPOSIT);
    } catch (err) {
      console.warn(
        `[deposit] ${this.storage.description} unreadable (${err.message}); using defaults`,
      );
      this.settings = structuredClone(DEFAULT_DEPOSIT);
    }
    return this.settings;
  }

  async save(input) {
    const settings = validateDeposit(input);
    await this.storage.write(settings);
    this.settings = settings;
    return settings;
  }

  /**
   * What the app is told: only the methods that are switched on, and a flag
   * saying whether deposits can be requested at all. The app shows an
   * explanation rather than an empty grid when they cannot.
   */
  publicConfig() {
    const methods = this.settings.methods
      .filter((m) => m.enabled)
      .map(({ id, name, logoUrl }) => ({ id, name, logoUrl }));
    return {
      whatsappNumber: this.settings.whatsappNumber,
      minAmount: this.settings.minAmount,
      currency: this.settings.currency,
      methods,
      open: Boolean(this.settings.whatsappNumber) && methods.length > 0,
    };
  }
}

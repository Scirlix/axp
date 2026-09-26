// User-portal integration: login and account balances from the AXP portal
// (UpTrader Trader's Room at login.axp-portal.com). The app never talks to
// the portal directly — it calls our backend, which proxies requests.
//
// IMPORTANT: UpTrader exposes no separate "API key" for this instance. The
// portal's own web app authenticates each *user* with their email/password
// and gets a per-user JWT, then sends `Authorization: JWT <token>` on every
// request. We reproduce that exact flow here, so the only config we need is
// the portal base URL (config.uptrader.apiUrl). There is no shared secret.
//
// Login is two steps, mirroring the browser:
//   1. POST /api/auth/get_otp_token/  { emailOrPhone, password, rememberMe }
//        -> { otpToken, nextAction }.  nextAction === 'login' means no 2FA.
//   2. POST /api/auth/get_token/      (same body, Authorization: JWT otpToken)
//        -> { token }.  This `token` is the session JWT used for everything.
// If the account has 2FA enabled, nextAction is something other than 'login'
// and an OTP code step is required — we surface that clearly rather than
// silently failing.

export class NotConfiguredError extends Error {
  constructor(message = 'User portal is not connected yet.') {
    super(message);
    this.code = 'not_configured';
  }
}

export class AuthError extends Error {
  constructor(message = 'Invalid email or password.') {
    super(message);
    this.code = 'auth_failed';
  }
}

/** Raised when the account needs a 2FA / OTP code we can't supply here. */
export class TwoFactorRequiredError extends AuthError {
  constructor(nextAction) {
    super('This account requires a two-factor code to sign in.');
    this.code = 'tfa_required';
    this.nextAction = nextAction;
  }
}

/**
 * Shape returned to the app:
 *   session  { token, name, email }
 *   summary  { currency, totalReal, accounts: [...] }
 * Each account is
 *   { id, login, group, type, balance, equity, availableToWithdraw,
 *     currency, platform, platformSlug, server, leverage, availableLeverages,
 *     partnerCode, isBlocked, isArchived }
 * `type` is 'real' | 'demo'. `platformSlug` is 'mt5' or 'wallet'.
 * `totalReal` sums the balances of real (non-demo) *trading* accounts in
 * `currency` — wallets are excluded, matching the portal's own total.
 */
export class AccountService {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.source = new UptraderSource(config.uptrader ?? {}, fetchImpl);
  }

  get configured() {
    return this.source.configured;
  }

  /** @returns {Promise<{token,name,email}>} */
  login(email, password) {
    return this.source.login(email, password);
  }

  /** @returns {Promise<{currency,totalReal,accounts}>} */
  summary(token) {
    return this.source.summary(token);
  }
}

/**
 * Adapter for the AXP portal (UpTrader Trader's Room) web API. Talks to the
 * same JSON endpoints the browser SPA uses, under `${apiUrl}/api`.
 */
export class UptraderSource {
  static NAME = 'AXP portal (UpTrader)';

  constructor(cfg, fetchImpl = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    // Trim a trailing slash so we can append paths cleanly.
    this.base = (cfg.apiUrl || '').replace(/\/+$/, '');
  }

  get configured() {
    // The portal uses per-user JWTs, not a shared key — the URL is enough.
    return Boolean(this.base);
  }

  #ensureConfigured() {
    if (!this.configured) throw new NotConfiguredError();
  }

  /** Low-level JSON request against the portal API. */
  async #request(method, path, { token, body } = {}) {
    const headers = { accept: 'application/json', locale: 'en' };
    if (token) headers.authorization = `JWT ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, ok: res.ok, data };
  }

  async login(email, password) {
    this.#ensureConfigured();
    const creds = { emailOrPhone: email, password, rememberMe: true };

    // Step 1: exchange credentials for a short-lived OTP token.
    const otp = await this.#request('POST', '/api/auth/get_otp_token/', { body: creds });
    if (otp.status === 401 || otp.status === 400) {
      throw new AuthError();
    }
    if (!otp.ok || !otp.data?.otpToken) {
      throw new AuthError('The portal rejected the sign-in request.');
    }
    if (otp.data.nextAction && otp.data.nextAction !== 'login') {
      // e.g. an SMS/authenticator OTP code is required before get_token.
      throw new TwoFactorRequiredError(otp.data.nextAction);
    }

    // Step 2: trade the OTP token for the real session JWT.
    const tok = await this.#request('POST', '/api/auth/get_token/', {
      token: otp.data.otpToken,
      body: creds,
    });
    if (tok.status === 401) throw new AuthError();
    if (!tok.ok || !tok.data?.token) {
      throw new AuthError('The portal did not return a session token.');
    }
    const token = tok.data.token;

    // Fill in the display name from the user profile (best-effort).
    let name = email;
    try {
      const me = await this.#request('GET', '/api/user/', { token });
      if (me.ok && me.data) {
        name = me.data.fullName || me.data.firstName || email;
      }
    } catch {
      /* name is cosmetic; ignore */
    }

    return { token, name, email };
  }

  async summary(token) {
    this.#ensureConfigured();
    if (!token) throw new AuthError('Sign in required.');

    // Trading accounts (with live equity/balance) plus wallet accounts.
    const [trading, wallet] = await Promise.all([
      this.#request('GET', '/api/platforms/account_prefetch/', { token }),
      this.#request('GET', '/api/platforms/account_prefetch/wallet/', { token }),
    ]);

    if (trading.status === 401) throw new AuthError('Session expired. Sign in again.');
    if (!trading.ok || !Array.isArray(trading.data)) {
      throw new Error(`Unexpected accounts response (status ${trading.status}).`);
    }

    const raw = [
      ...trading.data,
      ...(wallet.ok && Array.isArray(wallet.data) ? wallet.data : []),
    ];

    // Portal money objects are { amount: "0.61", currency: "USD" } — the
    // amount is a string, so it always goes through Number().
    const amount = (money) => Number(money?.amount ?? 0);

    const accounts = raw.map((a) => {
      const bal = a.balance ?? {};
      const balance = amount(bal);
      return {
        id: a.id,
        login: a.login,
        group: a.accountTypeTitle ?? a.accountTypeServer ?? null,
        type: a.isDemo ? 'demo' : 'real',
        balance,
        // Wallets report neither equity nor free margin — fall back to the
        // balance so every account carries all three figures.
        equity: 'equity' in a ? amount(a.equity) : balance,
        availableToWithdraw: 'marginFree' in a ? amount(a.marginFree) : balance,
        currency: bal.currency ?? a.currency ?? 'USD',
        platform: a.platformTitle ?? a.platformSlug ?? null,
        platformSlug: a.platformSlug ?? null,
        server: a.accountTypeServer ?? null,
        leverage: a.leverage ?? null,
        availableLeverages: a.availableLeverages ?? [],
        partnerCode: a.partnerCode ?? null,
        // Set by the broker; a blocked account can't fund, withdraw or trade.
        isBlocked: Boolean(a.isBlocked),
        isArchived: Boolean(a.isArchived),
      };
    });

    // Pick the currency from the first real account, else the first account,
    // else USD. Sum only real trading balances in that currency (mixed-
    // currency conversion is out of scope — the app converts elsewhere).
    const real = accounts.filter(
      (a) => a.type === 'real' && a.platformSlug !== 'wallet',
    );
    const currency = (real[0] ?? accounts[0])?.currency ?? 'USD';
    const totalReal = real
      .filter((a) => a.currency === currency)
      .reduce((sum, a) => sum + a.balance, 0);

    return { currency, totalReal, accounts };
  }
}

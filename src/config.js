/**
 * Reads settings from environment variables. `src/standalone.js` loads a local
 * `.env` first (real environment variables win).
 */
export function loadConfig(env = process.env) {
  const int = (key, fallback) => {
    const n = Number.parseInt(env[key] ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const key = env.TWELVE_DATA_API_KEY?.trim();

  return {
    port: int('PORT', 8080),
    // Dashboard sign-in. Both are needed for /admin to be reachable; they are
    // credentials, so they live in the environment, never in the repo.
    admin: {
      email: env.ADMIN_EMAIL?.trim() || null,
      password: env.ADMIN_PASSWORD || null,
    },
    layoutFile: env.LAYOUT_FILE?.trim() || 'data/layout.json',
    depositFile: env.DEPOSIT_FILE?.trim() || 'data/deposit.json',
    // Serverless hosts freeze between requests, so the polling timers never
    // fire; quotes are refreshed while serving /v1/quotes instead.
    refreshOnRequest: Boolean(env.VERCEL),

    // AXP user portal (UpTrader Trader's Room). Only the base URL is needed:
    // the portal authenticates each user with their own email/password and
    // issues a per-user JWT — there is no shared server key. apiKey is kept
    // for compatibility but is unused by this integration.
    uptrader: {
      apiUrl: env.UPTRADER_API_URL?.trim() || null,
      apiKey: env.UPTRADER_API_KEY?.trim() || null,
    },

    twelveDataApiKey: key || null,
    // Free Basic plan limits. Forex polling is spaced automatically to stay
    // within these, based on how many instruments are active.
    twelveDataCreditsPerDay: int('TWELVE_DATA_CREDITS_PER_DAY', 800),
    twelveDataCreditsPerMinute: int('TWELVE_DATA_CREDITS_PER_MINUTE', 8),
    // Never poll forex faster than this, even on a paid plan.
    fxMinPollMs: int('FX_MIN_POLL_SECONDS', 60) * 1000,
    metalsPollMs: int('METALS_POLL_SECONDS', 10) * 1000,
    referenceRefreshMs: int('REFERENCE_REFRESH_MINUTES', 360) * 60_000,
  };
}

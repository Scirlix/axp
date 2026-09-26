import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { AuthError, NotConfiguredError } from './accountService.js';
import { CATALOG } from './catalog.js';
import { DepositError } from './depositStore.js';
import { LayoutError, MAX_HOME } from './layoutStore.js';
import { createPortalProxy } from './portalProxy.js';

const DASHBOARD_DIR = fileURLToPath(new URL('../public/admin', import.meta.url));

/**
 * Routes:
 *   Public (used by the app, CORS enabled)
 *     GET  /health            service status and last upstream errors
 *     GET  /v1/quotes         Home/Markets layout + latest quotes
 *     POST /v1/auth/login     sign in to the AXP user portal (CRM)
 *     GET  /v1/account/summary  the user's real-account balances
 *     GET  /v1/deposit/config   payment channels + the WhatsApp number
 *   Admin (Bearer token)
 *     GET /v1/admin/state     catalogue, layout, quotes, deposits, status
 *     PUT /v1/admin/layout    save which instruments show on Home / Markets
 *     PUT /v1/admin/deposit   save payment channels and the WhatsApp number
 *   Dashboard
 *     GET /admin              the admin web page
 *
 * @param {{ quotes: import('./quoteService.js').QuoteService,
 *           layout: import('./layoutStore.js').LayoutStore,
 *           accounts: import('./accountService.js').AccountService,
 *           deposits: import('./depositStore.js').DepositStore,
 *           adminToken: string, config: object }} deps
 */
export function createApp({ quotes, layout, accounts, deposits, adminToken, config }) {
  const app = express();
  app.disable('x-powered-by');

  // ---------------------------------------------------------------- public
  const publicApi = express.Router();
  // Allows the Flutter web build (served from another origin) to call these.
  // Scoped to the public paths only — admin routes must stay same-origin.
  const cors = (req, res, next) => {
    res.set({
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'cache-control': 'no-store',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
  publicApi.use(['/health', '/v1/quotes', '/v1/auth', '/v1/account', '/v1/deposit'], cors);

  publicApi.get('/health', (req, res) => res.json({ status: 'ok', ...quotes.health() }));

  // Which payment channels the app offers right now, and where deposit
  // requests are sent. Public: it carries no secrets, and the app needs it
  // before the user has done anything.
  publicApi.get('/v1/deposit/config', (req, res) => res.json(deposits.publicConfig()));

  publicApi.get('/v1/quotes', async (req, res) => {
    // On a host without background timers (Vercel), refresh as part of
    // serving the request; elsewhere this is a no-op because the poller has
    // already kept everything current.
    if (config.refreshOnRequest) await quotes.ensureFresh();
    const filter =
      typeof req.query.symbols === 'string'
        ? new Set(req.query.symbols.split(',').map((s) => s.trim().toUpperCase()))
        : null;
    res.json({
      serverTime: new Date().toISOString(),
      layout: layout.layout,
      quotes: quotes.snapshot().filter((q) => !filter || filter.has(q.symbol)),
    });
  });

  // ------------------------------------------------------- user portal auth
  // Maps portal errors to status codes: 501 when the CRM isn't connected
  // yet, 401 on bad credentials / missing token.
  const portal = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        return res.status(501).json({ error: err.message, code: err.code });
      }
      if (err instanceof AuthError) {
        return res.status(401).json({ error: err.message, code: err.code });
      }
      console.error('[portal]', err);
      res.status(502).json({ error: 'The user portal could not be reached.' });
    }
  };

  publicApi.post(
    '/v1/auth/login',
    express.json({ limit: '4kb' }),
    portal(async (req, res) => {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }
      res.json({ session: await accounts.login(email, password) });
    }),
  );

  publicApi.get(
    '/v1/account/summary',
    portal(async (req, res) => {
      const token = /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1];
      if (!token) return res.status(401).json({ error: 'Sign in required.' });
      res.json(await accounts.summary(token));
    }),
  );

  app.use(publicApi);

  // Same-origin path to the portal, for the Flutter web build (see
  // portalProxy.js). Mounted before the admin routes so it is never shadowed.
  app.use('/portal', createPortalProxy(config.uptrader?.apiUrl));

  // ----------------------------------------------------------------- admin
  const adminApi = express.Router();
  adminApi.use(requireAdmin(adminToken));
  adminApi.use(express.json({ limit: '10kb' }));

  const state = () => ({
    catalog: CATALOG,
    layout: layout.layout,
    deposit: deposits.settings,
    quotes: quotes.snapshot(),
    status: quotes.health(),
    limits: {
      maxHome: MAX_HOME,
      // Lets the dashboard preview the forex refresh rate before saving.
      twelveData: Boolean(config.twelveDataApiKey),
      creditsPerDay: config.twelveDataCreditsPerDay,
      referenceRefreshMinutes: config.referenceRefreshMs / 60_000,
      fxMinPollSeconds: config.fxMinPollMs / 1000,
    },
  });

  adminApi.get('/state', (req, res) => res.json(state()));

  adminApi.put('/layout', async (req, res, next) => {
    try {
      await layout.save(req.body);
    } catch (err) {
      if (err instanceof LayoutError) return res.status(400).json({ error: err.message });
      return next(err);
    }
    // New instruments are fetched in the background; Twelve Data's
    // per-minute limit can make that take a minute or two.
    quotes.setSymbols(layout.activeSymbols()).catch((err) => {
      console.warn(`[layout] refresh after save failed: ${err.message}`);
    });
    console.log(`[layout] saved — home: ${layout.layout.home.join(', ')}`);
    res.json(state());
  });

  adminApi.put('/deposit', async (req, res, next) => {
    try {
      await deposits.save(req.body);
    } catch (err) {
      if (err instanceof DepositError) return res.status(400).json({ error: err.message });
      return next(err);
    }
    const on = deposits.settings.methods.filter((m) => m.enabled).map((m) => m.name);
    console.log(`[deposit] saved — methods: ${on.join(', ') || 'none'}`);
    res.json(state());
  });

  app.use('/v1/admin', adminApi);

  // ------------------------------------------------------------- dashboard
  app.get('/', (req, res) => res.redirect('/admin/'));
  app.use('/admin', express.static(DASHBOARD_DIR, { index: 'index.html' }));

  // ---------------------------------------------------------------- errors
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body is not valid JSON.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}

/** Checks `Authorization: Bearer <token>` in constant time. */
function requireAdmin(token) {
  const digest = (s) => createHash('sha256').update(s).digest();
  const expected = digest(token);
  return (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
    if (!match || !timingSafeEqual(digest(match[1]), expected)) {
      return res.status(401).json({ error: 'Invalid admin token.' });
    }
    next();
  };
}

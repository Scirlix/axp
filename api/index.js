import { AccountService } from '../src/accountService.js';
import { AdminAuth } from '../src/adminAuth.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/createApp.js';
import { DepositStore } from '../src/depositStore.js';
import { LayoutStore } from '../src/layoutStore.js';
import { QuoteService } from '../src/quoteService.js';
import { checkPersistence, pickStorage } from '../src/storage.js';

/**
 * Vercel entry point. Everything under / is routed here by vercel.json, so
 * this module owns the whole API and the admin dashboard.
 *
 * Differences from src/standalone.js, which still runs the long-lived local
 * server:
 *
 *  - Startup is lazy and memoised. A serverless instance handles many
 *    requests, so the work is done once per cold start and shared, but it
 *    cannot happen at import time because it is async.
 *  - No `listen`, and no polling timers: the instance is frozen between
 *    requests, so quotes refresh while serving /v1/quotes instead (see
 *    QuoteService.ensureFresh).
 *  - Settings go to Redis when it is configured, because the filesystem here
 *    is read-only (see storage.js).
 *  - Dashboard sessions must survive a cold start, which they do because
 *    AdminAuth signs them with a key derived from ADMIN_EMAIL /
 *    ADMIN_PASSWORD: every instance derives the same one.
 */

let ready = null;

async function boot() {
  const config = loadConfig();

  const auth = new AdminAuth(config.admin);
  if (!auth.configured) {
    console.warn(
      '[admin] ADMIN_EMAIL / ADMIN_PASSWORD are not set in the project ' +
        'environment variables, so /admin cannot be signed into.',
    );
  }

  const layoutStorage = pickStorage('axp:layout', config.layoutFile);
  const depositStorage = pickStorage('axp:deposit', config.depositFile);
  checkPersistence(layoutStorage);

  const layout = new LayoutStore(layoutStorage);
  const deposits = new DepositStore(depositStorage);
  await Promise.all([layout.load(), deposits.load()]);

  const quotes = new QuoteService(config);
  // Fetch once so the first response is not empty; the timers that start()
  // would normally set up simply never fire here.
  await quotes.start(layout.activeSymbols());

  const accounts = new AccountService(config);
  return createApp({ quotes, layout, accounts, deposits, auth, config });
}

export default async function handler(req, res) {
  try {
    ready ??= boot();
    const app = await ready;
    return app(req, res);
  } catch (err) {
    // A failed boot must not be cached, or the deployment stays broken until
    // the instance is recycled.
    ready = null;
    console.error('[boot]', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'The service failed to start.' }));
  }
}

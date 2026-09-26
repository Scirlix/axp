import { randomBytes } from 'node:crypto';

import { AccountService } from '../src/accountService.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DepositStore } from '../src/depositStore.js';
import { LayoutStore } from '../src/layoutStore.js';
import { QuoteService } from '../src/quoteService.js';
import { checkPersistence, pickStorage } from '../src/storage.js';

/**
 * Vercel entry point. Everything under / is routed here by vercel.json, so
 * this module owns the whole API and the admin dashboard.
 *
 * Differences from src/server.js, which still runs the long-lived local
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
 */

let ready = null;

async function boot() {
  const config = loadConfig();

  // Without ADMIN_TOKEN each cold start would invent a different one and
  // nobody could stay signed in to the dashboard. Fail loudly instead.
  let adminToken = config.adminToken;
  if (!adminToken) {
    adminToken = randomBytes(18).toString('base64url');
    console.warn(
      '[admin] No ADMIN_TOKEN set. A random one was generated for this ' +
        'instance and will change on every cold start — set ADMIN_TOKEN in ' +
        'the project environment variables.',
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
  return createApp({ quotes, layout, accounts, deposits, adminToken, config });
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

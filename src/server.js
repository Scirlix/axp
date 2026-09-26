import { existsSync } from 'node:fs';

import { AccountService } from './accountService.js';
import { AdminAuth } from './adminAuth.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { DepositStore } from './depositStore.js';
import { LayoutStore } from './layoutStore.js';
import { QuoteService } from './quoteService.js';

// Local settings; real environment variables take precedence.
if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();

const auth = new AdminAuth(config.admin);
console.log(
  auth.configured
    ? `[admin] dashboard sign-in: ${auth.email}`
    : '[admin] ADMIN_EMAIL / ADMIN_PASSWORD are not set — nobody can sign in to /admin',
);

const layout = new LayoutStore(config.layoutFile);
await layout.load();

const deposits = new DepositStore(config.depositFile);
await deposits.load();
console.log(
  deposits.settings.whatsappNumber
    ? `[deposit] requests go to WhatsApp +${deposits.settings.whatsappNumber}`
    : '[deposit] no WhatsApp number set — deposits are closed until one is saved in /admin',
);

const quotes = new QuoteService(config);
console.log(
  config.twelveDataApiKey
    ? '[quotes] forex: Twelve Data'
    : '[quotes] forex: ECB daily reference rates — set TWELVE_DATA_API_KEY for live forex',
);
await quotes.start(layout.activeSymbols());
const { forexPollSeconds, metalsPollSeconds } = quotes.health();
console.log(
  `[quotes] ${quotes.active.length} instruments — forex every ${forexPollSeconds}s, ` +
    `metals every ${metalsPollSeconds}s`,
);

const accounts = new AccountService(config);
console.log(
  accounts.configured
    ? '[portal] AXP user portal (UpTrader CRM) connected'
    : '[portal] user portal not connected — set UPTRADER_API_URL / UPTRADER_API_KEY',
);

// All interfaces, so phones / emulators on the LAN can reach it.
const server = createApp({ quotes, layout, accounts, deposits, auth, config }).listen(
  config.port,
  '0.0.0.0',
  () => {
    console.log(`AXP backend listening on http://localhost:${config.port}`);
    console.log(`Dashboard: http://localhost:${config.port}/admin`);
  },
);

const shutdown = () => {
  quotes.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

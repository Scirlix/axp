import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AccountService, AuthError, NotConfiguredError } from '../src/accountService.js';
import { AdminAuth, LoginThrottle } from '../src/adminAuth.js';
import { DEFAULT_LAYOUT } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/createApp.js';
import { CreditLimiter } from '../src/creditLimiter.js';
import { DepositError, DepositStore, validateDeposit } from '../src/depositStore.js';
import { LayoutError, LayoutStore, validateLayout } from '../src/layoutStore.js';
import { QuoteService } from '../src/quoteService.js';

const ADMIN = { email: 'dashboard@axp.test', password: 'test-password' };
const config = (key) =>
  loadConfig({
    ...(key ? { TWELVE_DATA_API_KEY: key } : {}),
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
  });
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

const TD_QUOTES = {
  'EUR/USD': { close: '1.13916', previous_close: '1.13000', last_quote_at: 1790381160 },
  'GBP/USD': { close: '1.3200', previous_close: '1.3300' },
  'USD/JPY': { code: 404, message: 'nope', status: 'error' },
  'USD/CHF': { close: '0.8283', previous_close: '0.8283' },
  'AUD/USD': { close: '0.6600', previous_close: '0.6500' },
  'XAU/USD': { close: '4280.00', previous_close: '4200.00' },
  'XAG/USD': { close: '64.00', previous_close: '65.00' },
  'XPT/USD': { close: '1500.00', previous_close: '1490.00' },
};

/** Fake upstream covering gold-api, Twelve Data and Frankfurter. */
function upstream({ twelveDown = false } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.host === 'api.gold-api.com') {
      const asset = url.pathname.split('/').at(-1);
      const prices = { XAU: 4286.2, XAG: 64.419, XPT: 1510.5, XPD: 1200.25 };
      return ok({ currency: 'USD', price: prices[asset], symbol: asset, updatedAt: '2026-09-26T00:06:01Z' });
    }
    if (url.host === 'api.twelvedata.com') {
      if (twelveDown) return ok({ code: 429, message: 'limit', status: 'error' });
      const symbols = url.searchParams.get('symbol').split(',');
      const pick = (s) =>
        url.pathname === '/quote'
          ? (TD_QUOTES[s] ?? { close: '1.0000', previous_close: '1.0000' })
          : { price: TD_QUOTES[s]?.close ?? '1.0000' };
      return ok(symbols.length === 1 ? pick(symbols[0]) : Object.fromEntries(symbols.map((s) => [s, pick(s)])));
    }
    if (url.host === 'api.frankfurter.dev') {
      return ok({
        base: 'USD',
        rates: {
          '2026-09-24': { EUR: 0.88, GBP: 0.75, JPY: 157.0, CHF: 0.83 },
          '2026-09-25': { EUR: 0.87696, GBP: 0.75458, JPY: 157.59, CHF: 0.82829 },
        },
      });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

async function started(cfg, deps, symbols = [...new Set([...DEFAULT_LAYOUT.home, ...DEFAULT_LAYOUT.markets])]) {
  // Generous limiter by default so tests don't wait out real minute windows.
  const service = new QuoteService(cfg, { limiter: new CreditLimiter(1000), ...deps });
  cleanups.push(() => service.stop());
  await service.start(symbols);
  return service;
}

const bySymbol = (service) => Object.fromEntries(service.snapshot().map((q) => [q.symbol, q]));
const close = (actual, expected, eps = 1e-3) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`);

// ------------------------------------------------------------- quotes

test('with Twelve Data: forex live, metals from gold-api with reference', async () => {
  const { fetchImpl, calls } = upstream();
  const q = bySymbol(await started(config('k'), { fetchImpl }));

  assert.equal(q['EUR/USD'].price, 1.13916);
  assert.equal(q['EUR/USD'].source, 'Twelve Data');
  assert.equal(q['EUR/USD'].name, 'Euro / US Dollar');
  assert.equal(q['EUR/USD'].decimals, 5);
  close(q['EUR/USD'].changePercent, 0.8106);

  // Per-symbol upstream error: listed with no price yet, not fatal.
  assert.equal(q['USD/JPY'].price, null);

  // Metal price stays the live gold-api one; previous close from reference.
  assert.equal(q['XAU/USD'].price, 4286.2);
  assert.equal(q['XAU/USD'].source, 'gold-api.com');
  close(q['XAU/USD'].changePercent, 2.052);

  // gold-api rejects default user agents, so we must send our own.
  const goldCall = calls.find((c) => c.url.host === 'api.gold-api.com');
  assert.equal(goldCall.init.headers['user-agent'], 'AXP-Analytics-Backend/1.0');
});

test('without a key: forex falls back to ECB daily rates, crosses included', async () => {
  const q = bySymbol(
    await started(config(), upstream(), ['EUR/USD', 'USD/JPY', 'EUR/GBP', 'XAU/USD']),
  );
  close(q['EUR/USD'].price, 1 / 0.87696, 1e-9);
  close(q['EUR/USD'].previousClose, 1 / 0.88, 1e-9);
  assert.equal(q['USD/JPY'].price, 157.59);
  assert.equal(q['USD/JPY'].delayed, true);
  close(q['EUR/GBP'].price, 0.75458 / 0.87696, 1e-9);
  assert.equal(q['XAU/USD'].changePercent, null); // no reference without a key
});

test('Twelve Data outage at startup falls back to ECB and reports error', async () => {
  const service = await started(config('k'), upstream({ twelveDown: true }));
  assert.equal(bySymbol(service)['GBP/USD'].delayed, true);
  assert.ok('forex-init' in service.health().errors);
});

test('quotes are flagged stale when refreshes stop', async () => {
  let now = Date.UTC(2026, 8, 26, 12);
  const service = await started(config('k'), { ...upstream(), now: () => now });
  assert.equal(bySymbol(service)['XAU/USD'].stale, false);
  now += 5 * 60_000; // metals are expected every 10s
  assert.equal(bySymbol(service)['XAU/USD'].stale, true);
  assert.equal(bySymbol(service)['EUR/USD'].stale, false); // ~8 min cadence
});

test('forex interval stays within the daily credit budget', async () => {
  const service = await started(config('k'), upstream());
  // 4 forex + 2 metals: (800*0.9 - 6*4 refs) = 696 credits for 4 pairs.
  assert.equal(service.fxIntervalMs(), Math.ceil((4 * 86_400_000) / 696));

  await service.setSymbols(['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD',
    'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY']);
  const perDay = (86_400_000 / service.fxIntervalMs()) * 10 + 10 * 4;
  assert.ok(perDay <= 800 * 0.9 + 1, `uses ${perDay} credits/day`);
});

test('Twelve Data requests are batched to the per-minute credit limit', async () => {
  const { fetchImpl, calls } = upstream();
  const sleeps = [];
  let now = 0;
  const limiter = new CreditLimiter(8, {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  await started(config('k'), { fetchImpl, limiter }, [
    'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD',
    'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY',
  ]);
  const batches = calls
    .filter((c) => c.url.host === 'api.twelvedata.com')
    .map((c) => c.url.searchParams.get('symbol').split(',').length);
  assert.deepEqual(batches, [8, 2]);
  assert.equal(sleeps.length, 1); // waited for the next minute once
});

test('adding a symbol at runtime fetches it immediately', async () => {
  const service = await started(config('k'), upstream(), ['EUR/USD']);
  await service.setSymbols(['EUR/USD', 'XPT/USD']);
  const q = bySymbol(service);
  assert.equal(q['XPT/USD'].price, 1510.5);
  close(q['XPT/USD'].changePercent, (1510.5 - 1490) / 1490 * 100);
});

// ------------------------------------------------------------- layout

test('layout validation rejects unknown, duplicate and too many symbols', () => {
  assert.throws(() => validateLayout({ home: ['BTC/USD'], markets: [] }), LayoutError);
  assert.throws(() => validateLayout({ home: ['EUR/USD', 'EUR/USD'], markets: [] }), LayoutError);
  assert.throws(() => validateLayout({ home: 'EUR/USD', markets: [] }), LayoutError);
  const nine = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'NZD/USD', 'EUR/GBP', 'EUR/JPY'];
  assert.throws(() => validateLayout({ home: nine, markets: [] }), /at most 8/);
  assert.deepEqual(validateLayout({ home: ['XAU/USD'], markets: [] }), { home: ['XAU/USD'], markets: [] });
});

// ---------------------------------------------------------------- http

// Fake AccountService: signed-in only with the right password.
function stubAccounts({ configured = true } = {}) {
  return {
    configured,
    async login(email, password) {
      if (!configured) throw new NotConfiguredError();
      if (password !== 'good') throw new AuthError();
      return { token: 'crm-token', name: 'Ahmad', email };
    },
    async summary(token) {
      if (!configured) throw new NotConfiguredError();
      if (token !== 'crm-token') throw new AuthError('Session expired.');
      return {
        currency: 'USD',
        totalReal: 1234.56,
        accounts: [
          { id: '5001', type: 'real', balance: 1000, currency: 'USD', platform: 'MT5' },
          { id: '5002', type: 'real', balance: 234.56, currency: 'USD', platform: 'MT5' },
          { id: '9001', type: 'demo', balance: 10000, currency: 'USD', platform: 'MT5' },
        ],
      };
    },
  };
}

async function startServer({ key = 'k', accounts = stubAccounts() } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'axp-'));
  const layout = new LayoutStore(join(dir, 'layout.json'));
  await layout.load();
  const deposits = new DepositStore(join(dir, 'deposit.json'));
  await deposits.load();
  const cfg = config(key);
  const quotes = await started(cfg, upstream(), layout.activeSymbols());
  const server = createApp({
    quotes,
    layout,
    accounts,
    deposits,
    auth: new AdminAuth(cfg.admin),
    config: cfg,
  }).listen(0);
  cleanups.push(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://localhost:${server.address().port}`;
  const signIn = (credentials = ADMIN) =>
    fetch(`${base}/v1/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
    });
  // Every admin call below uses a token from the real sign-in route.
  const { session } = await (await signIn()).json();
  const admin = (path, init = {}) =>
    fetch(`${base}/v1/admin${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  return { base, admin, signIn, session, layout, quotes, deposits, dir };
}

test('GET /v1/quotes returns layout, metadata and CORS headers', async () => {
  const { base } = await startServer();
  const res = await fetch(`${base}/v1/quotes`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  assert.deepEqual(body.layout, DEFAULT_LAYOUT);
  const xau = body.quotes.find((q) => q.symbol === 'XAU/USD');
  assert.equal(xau.category, 'metals');
  assert.equal(xau.unit, '1 Oz');

  const filtered = await (await fetch(`${base}/v1/quotes?symbols=eur/usd,XAU/USD`)).json();
  assert.deepEqual(filtered.quotes.map((q) => q.symbol), ['EUR/USD', 'XAU/USD']);
});

test('admin sign-in issues a session token and rejects bad credentials', async () => {
  const { signIn, session } = await startServer();

  assert.equal(session.email, ADMIN.email);
  assert.ok(Date.parse(session.expiresAt) > Date.now());

  // The email is matched case-insensitively; the password is not.
  assert.equal((await signIn({ ...ADMIN, email: 'Dashboard@AXP.test' })).status, 200);

  const wrongPassword = await signIn({ ...ADMIN, password: 'test-Password' });
  assert.equal(wrongPassword.status, 401);
  // The message must not say which half was wrong.
  assert.match((await wrongPassword.json()).error, /Incorrect email or password/);

  assert.equal((await signIn({ email: 'someone@else.test', password: 'x' })).status, 401);
  assert.equal((await signIn({ email: ADMIN.email })).status, 400);
});

test('admin API requires a session token', async () => {
  const { base, admin, session } = await startServer();
  assert.equal((await fetch(`${base}/v1/admin/state`)).status, 401);
  assert.equal(
    (await fetch(`${base}/v1/admin/state`, { headers: { authorization: 'Bearer wrong' } })).status,
    401,
  );
  // A token with the claims edited but the old signature kept is not a token.
  const [claims, signature] = session.token.split('.');
  const forged = `${Buffer.from(
    JSON.stringify({ sub: ADMIN.email, exp: Date.now() + 864e5 }),
  ).toString('base64url')}.${signature}`;
  assert.equal(
    (await fetch(`${base}/v1/admin/state`, { headers: { authorization: `Bearer ${forged}` } }))
      .status,
    401,
  );
  assert.ok(claims);

  const res = await admin('/state');
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.ok(state.catalog.length >= 16);
  assert.equal(state.limits.maxHome, 8);
  // Admin routes must not be callable cross-origin.
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('saving a layout persists it and updates what the app receives', async () => {
  const { base, admin, dir } = await startServer();

  const bad = await admin('/layout', { method: 'PUT', body: JSON.stringify({ home: ['NOPE'], markets: [] }) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Unknown instrument/);

  const broken = await admin('/layout', { method: 'PUT', body: '{not json' });
  assert.equal(broken.status, 400);

  const next = { home: ['XPT/USD', 'EUR/USD'], markets: ['EUR/USD', 'XAU/USD', 'XPT/USD'] };
  const res = await admin('/layout', { method: 'PUT', body: JSON.stringify(next) });
  assert.equal(res.status, 200);

  assert.deepEqual(JSON.parse(await readFile(join(dir, 'layout.json'), 'utf8')), next);

  // Background fetch of the new symbol; give it a moment.
  await new Promise((r) => setTimeout(r, 50));
  const body = await (await fetch(`${base}/v1/quotes`)).json();
  assert.deepEqual(body.layout, next);
  assert.deepEqual(body.quotes.map((q) => q.symbol), ['EUR/USD', 'XAU/USD', 'XPT/USD']);
  assert.equal(body.quotes.find((q) => q.symbol === 'XPT/USD').price, 1510.5);
});

test('sessions expire, survive a restart, and die with the password', () => {
  const auth = new AdminAuth({ ...ADMIN, sessionMs: 60_000 });
  const { token } = auth.signIn(ADMIN.email, ADMIN.password);
  assert.equal(auth.verify(token).sub, ADMIN.email);

  // A second instance — a Vercel cold start — derives the same signing key,
  // so a token issued before it started is still good.
  assert.ok(new AdminAuth(ADMIN).verify(token));
  // Changing the password invalidates what is already out there.
  assert.equal(new AdminAuth({ ...ADMIN, password: 'rotated' }).verify(token), null);

  // An expired session is refused even though its signature is genuine.
  const stale = new AdminAuth({ ...ADMIN, sessionMs: -1 });
  assert.equal(stale.verify(stale.signIn(ADMIN.email, ADMIN.password).token), null);
  assert.equal(auth.verify('nonsense'), null);
  assert.equal(auth.verify(''), null);
  assert.equal(new AdminAuth({}).configured, false);
  assert.equal(new AdminAuth({}).signIn('', ''), null);
});

test('repeated failures lock an address out for the window', () => {
  const throttle = new LoginThrottle({ limit: 3, windowMs: 1000 });
  const now = Date.now();
  for (let i = 0; i < 2; i++) throttle.fail('1.2.3.4', now);
  assert.equal(throttle.retryAfter('1.2.3.4', now), 0);
  throttle.fail('1.2.3.4', now);
  assert.equal(throttle.retryAfter('1.2.3.4', now), 1);
  // Other addresses are unaffected, and the window eventually passes.
  assert.equal(throttle.retryAfter('5.6.7.8', now), 0);
  assert.equal(throttle.retryAfter('1.2.3.4', now + 1001), 0);
  // A success clears the count straight away.
  throttle.fail('1.2.3.4', now + 2000);
  throttle.succeed('1.2.3.4');
  assert.equal(throttle.retryAfter('1.2.3.4', now + 2000), 0);
});

test('dashboard page is served', async () => {
  const { base } = await startServer();
  const res = await fetch(`${base}/admin/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /AXP Dashboard/);
});

// ------------------------------------------------------------- user portal

const postJson = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('login and account summary work through the portal (stub CRM)', async () => {
  const { base } = await startServer();

  const bad = await postJson(base, '/v1/auth/login', { email: 'a@b.c', password: 'x' });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).code, 'auth_failed');

  const missing = await postJson(base, '/v1/auth/login', { email: 'a@b.c' });
  assert.equal(missing.status, 400);

  const ok = await postJson(base, '/v1/auth/login', { email: 'a@b.c', password: 'good' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*'); // app-facing
  const { session } = await ok.json();
  assert.equal(session.token, 'crm-token');

  const noAuth = await fetch(`${base}/v1/account/summary`);
  assert.equal(noAuth.status, 401);

  const summary = await fetch(`${base}/v1/account/summary`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  assert.equal(summary.status, 200);
  const body = await summary.json();
  assert.equal(body.totalReal, 1234.56);
  assert.equal(body.accounts.filter((a) => a.type === 'real').length, 2);
});

test('portal reports 501 when the CRM is not connected', async () => {
  const { base } = await startServer({ accounts: stubAccounts({ configured: false }) });
  const res = await postJson(base, '/v1/auth/login', { email: 'a@b.c', password: 'good' });
  assert.equal(res.status, 501);
  assert.equal((await res.json()).code, 'not_configured');
});

test('AccountService is unconfigured without UpTrader env and throws', async () => {
  const service = new AccountService(config());
  assert.equal(service.configured, false);
  await assert.rejects(() => service.login('a@b.c', 'x'), NotConfiguredError);
  await assert.rejects(() => service.summary('t'), NotConfiguredError);
});

// ------------------------------------------------------------- deposits

test('deposit validation rejects bad numbers, amounts and logos', () => {
  const ok = validateDeposit({
    whatsappNumber: '+964 770 222 0011',
    minAmount: 10,
    currency: 'usd',
    methods: [{ id: 'FIB', name: 'FIB', logoUrl: '', enabled: true }],
  });
  // Stored ready for a wa.me link, and normalised.
  assert.equal(ok.whatsappNumber, '9647702220011');
  assert.equal(ok.currency, 'USD');
  assert.equal(ok.methods[0].id, 'fib');

  // A blank number is allowed — that is how deposits are closed.
  assert.equal(validateDeposit({ ...ok, whatsappNumber: '' }).whatsappNumber, '');

  const bad = (patch, why) =>
    assert.throws(() => validateDeposit({ ...ok, ...patch }), DepositError, why);
  bad({ whatsappNumber: '12345' }, 'too short');
  bad({ minAmount: 0 }, 'zero minimum');
  bad({ minAmount: 'ten' }, 'non-numeric minimum');
  bad({ currency: 'DOLLAR' }, 'bad currency');
  bad({ methods: [] }, 'no methods');
  bad({ methods: [{ id: 'fib', name: '', enabled: true }] }, 'unnamed method');
  bad(
    { methods: [{ id: 'a', name: 'A', logoUrl: 'javascript:alert(1)', enabled: true }] },
    'non-http logo',
  );
  bad(
    {
      methods: [
        { id: 'fib', name: 'FIB', enabled: true },
        { id: 'fib', name: 'Again', enabled: true },
      ],
    },
    'duplicate id',
  );
});

test('the app is only told about channels that are switched on', async () => {
  const { base, admin } = await startServer();

  // Out of the box there is no WhatsApp number, so deposits are closed.
  let res = await fetch(`${base}/v1/deposit/config`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  let body = await res.json();
  assert.equal(body.open, false);
  assert.equal(body.minAmount, 10);
  assert.equal(body.currency, 'USD');

  const saved = await admin('/deposit', {
    method: 'PUT',
    body: JSON.stringify({
      whatsappNumber: '+9647702220011',
      minAmount: 25,
      currency: 'USD',
      methods: [
        { id: 'fib', name: 'FIB', logoUrl: 'https://fib.iq/logo.png', enabled: true },
        { id: 'zaincash', name: 'ZainCash', logoUrl: '', enabled: false },
      ],
    }),
  });
  assert.equal(saved.status, 200);
  // The admin still sees both, so a channel can be switched back on.
  assert.equal((await saved.json()).deposit.methods.length, 2);

  body = await (await fetch(`${base}/v1/deposit/config`)).json();
  assert.equal(body.open, true);
  assert.equal(body.whatsappNumber, '9647702220011');
  assert.equal(body.minAmount, 25);
  assert.deepEqual(
    body.methods,
    [{ id: 'fib', name: 'FIB', logoUrl: 'https://fib.iq/logo.png' }],
  );
});

test('deposit settings survive a restart and a bad save is rejected', async () => {
  const { admin, deposits } = await startServer();

  const bad = await admin('/deposit', {
    method: 'PUT',
    body: JSON.stringify({ whatsappNumber: '1', minAmount: 10, methods: [] }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /8 to 15 digits/);

  await admin('/deposit', {
    method: 'PUT',
    body: JSON.stringify({
      whatsappNumber: '9647702220011',
      minAmount: 10,
      currency: 'USD',
      methods: [{ id: 'fib', name: 'FIB', logoUrl: '', enabled: true }],
    }),
  });

  // A fresh store over the same file sees what was written.
  const reloaded = new DepositStore(deposits.storage.path);
  await reloaded.load();
  assert.equal(reloaded.settings.whatsappNumber, '9647702220011');
  assert.equal(reloaded.publicConfig().open, true);
});

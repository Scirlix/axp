# AXP Backend

Quotes API and admin dashboard for the AXP Analytics app.

- **Dashboard** (`/admin`): choose which instruments the app shows on its
  Home page (and in what order) and which are listed on the Markets page.
  Changes reach every app user within ~5 seconds — no app release needed.
- **Quotes API** (`/v1/quotes`): the app polls this for the layout and live
  prices. The backend polls upstream providers on a schedule and serves every
  user from an in-memory cache, so provider rate limits don't scale with users
  and API keys never ship inside the app.

## Run

Requires Node.js 20.12+.

```sh
cp .env.example .env    # set ADMIN_TOKEN and (optionally) TWELVE_DATA_API_KEY
npm install
npm start               # or: npm run dev  (restarts on file changes)
```

- API: `http://localhost:8080`
- Dashboard: `http://localhost:8080/admin` — sign in with `ADMIN_TOKEN`. If it
  isn't set, a random token is generated and printed at startup.

## Instruments and sources

The catalogue (`src/catalog.js`) has 12 forex pairs and 4 metals. Only the
ones switched on in the dashboard are polled.

| Instruments | Source | Refresh | Key |
|---|---|---|---|
| Metals: XAU, XAG, XPT, XPD (USD/oz) | [gold-api.com](https://gold-api.com) | every 10 s | none |
| Forex (majors + crosses) | [Twelve Data](https://twelvedata.com) | automatic, see below | `TWELVE_DATA_API_KEY` |
| Forex fallback (no key / outage) | ECB reference rates via [frankfurter.dev](https://frankfurter.dev) | daily, marked `delayed` | none |

**Forex refresh is budgeted automatically.** Twelve Data's free plan allows 800
credits/day and 8/minute (1 credit per symbol). The backend spaces forex polls
so the active pairs fit the daily allowance, and splits requests into batches
of 8 per minute. More pairs → slower refresh: 4 pairs ≈ every 8 min, 12 pairs ≈
every 26 min. The dashboard previews the new rate before you save. For faster
forex, raise `TWELVE_DATA_CREDITS_PER_DAY` / `_PER_MINUTE` on a paid plan, or
plug in the broker's MT5 price feed as a new source.

Daily % change needs a previous close, which comes from Twelve Data (for
metals too). Without a key, metals show no change rather than a made-up one.

## API

Public (CORS enabled, used by the app):

- `GET /v1/quotes` — layout + quotes. Filter with `?symbols=EUR/USD,XAU/USD`.
- `GET /health` — active sources, refresh intervals, last error per job.

```json
{
  "layout": { "home": ["XAU/USD", "EUR/USD"], "markets": ["EUR/USD", "XAU/USD"] },
  "quotes": [{
    "symbol": "EUR/USD", "name": "Euro / US Dollar", "category": "forex",
    "unit": "1 Euro", "decimals": 5,
    "price": 1.13916, "previousClose": 1.13, "change": 0.00916, "changePercent": 0.81,
    "updatedAt": "2026-09-26T00:06:00.000Z", "source": "Twelve Data",
    "delayed": false, "stale": false
  }]
}
```

`price` is `null` for an instrument that was just switched on and hasn't been
fetched yet. `stale` turns true when a quote hasn't refreshed for 3× its
polling interval.

Admin (`Authorization: Bearer <ADMIN_TOKEN>`, same-origin only):

- `GET /v1/admin/state` — catalogue, layout, quotes, polling status.
- `PUT /v1/admin/layout` — `{ "home": [...], "markets": [...] }`. Validated
  (known symbols, no duplicates, max 8 on Home) and saved to `LAYOUT_FILE`.

## Project layout

```
src/
  server.js          entry: loads .env, admin token, layout, starts polling
  app.js             Express routes, admin auth, dashboard static files
  quoteService.js    polling schedule, credit budget, in-memory cache
  catalog.js         every instrument the backend can price
  layoutStore.js     Home / Markets layout: validation + JSON persistence
  creditLimiter.js   per-minute API credit limiter
  config.js          settings from environment variables
  http.js            fetch helper (timeout, user agent, errors)
  sources/           one adapter per upstream provider
public/admin/        dashboard (plain HTML/CSS/JS, no build step)
test/                node:test suite with a fake upstream
data/layout.json     saved layout (created on first save; gitignored)
```

## Test

```sh
npm test
```

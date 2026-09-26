// AXP admin dashboard: choose which instruments the app shows on Home and
// Markets. Signing in with the dashboard email and password returns a session
// token, which every /v1/admin/* call then sends as a Bearer header.

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'axp-admin-session';
const REFRESH_MS = 5000;

let token = readToken();
let server = null; // last state from the backend
let draft = null; // { home: [], markets: [] } being edited
let depositDraft = null; // deposit settings being edited
let refreshTimer = null;

// ------------------------------------------------------------------ api

async function api(path, options = {}) {
  const res = await fetch(`/v1/admin${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    signOut('Your session has ended. Please sign in again.');
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// --------------------------------------------------------------- session

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(value) {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: token lives in memory only */
  }
}

function signOut(message) {
  token = null;
  storeToken(null);
  clearInterval(refreshTimer);
  server = draft = null;
  $('mainView').hidden = true;
  $('saveBar').hidden = true;
  $('status').hidden = true;
  $('signOut').hidden = true;
  $('loginView').hidden = false;
  $('loginError').hidden = !message;
  $('loginError').textContent = message || '';
  $('passwordInput').value = '';
  ($('emailInput').value ? $('passwordInput') : $('emailInput')).focus();
}

/**
 * Trades the credentials for a session token. A rejection the admin can act on
 * (wrong password, too many attempts) is flagged `shown` so the caller puts it
 * in the form rather than treating it as a backend outage.
 */
async function requestSession(email, password) {
  const res = await fetch('/v1/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Sign-in failed (${res.status}).`);
    err.shown = true;
    throw err;
  }
  return body.session.token;
}

/** Opens the dashboard with [value] as the session token. */
async function openDashboard(value) {
  token = value;
  const state = await api('/state'); // throws + shows login on 401
  storeToken(value);
  $('loginView').hidden = true;
  $('mainView').hidden = false;
  $('signOut').hidden = false;
  applyServerState(state, { resetDraft: true });
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshPrices, REFRESH_MS);
}

// ----------------------------------------------------------------- state

function applyServerState(state, { resetDraft = false } = {}) {
  server = state;
  if (resetDraft || !draft) draft = structuredClone(state.layout);
  if (resetDraft || !depositDraft) {
    depositDraft = structuredClone(state.deposit);
    // Rebuilt only here and on discard: rebuilding while the admin types in
    // a name or URL field would steal focus mid-word.
    buildDepositUi();
  }
  render();
}

async function refreshPrices() {
  try {
    // Only prices/status change on a refresh; the draft is untouched and the
    // table isn't rebuilt, so focus and in-progress clicks are preserved.
    server = await api('/state');
    updateLiveValues();
  } catch {
    /* next tick will retry; 401 is handled in api() */
  }
}

const layoutDirty = () => JSON.stringify(draft) !== JSON.stringify(server.layout);

const depositDirty = () =>
  JSON.stringify(depositDraft) !== JSON.stringify(server.deposit);

const isDirty = () => layoutDirty() || depositDirty();

const quoteFor = (symbol) => server.quotes.find((q) => q.symbol === symbol);

// ------------------------------------------------------------ formatting

function formatPrice(q) {
  if (!q || q.price == null) return '—';
  return q.price.toLocaleString('en-US', {
    minimumFractionDigits: q.decimals,
    maximumFractionDigits: q.decimals,
  });
}

function formatChange(q) {
  if (!q || q.changePercent == null) return { text: '—', cls: 'none' };
  const v = q.changePercent;
  return { text: `${v > 0 ? '+' : ''}${v.toFixed(2)}%`, cls: v < 0 ? 'neg' : '' };
}

function formatDuration(seconds) {
  if (seconds == null) return '—';
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

/** Same budget formula as the backend (QuoteService.fxIntervalMs). */
function previewForexSeconds(layout) {
  const { limits } = server;
  if (!limits.twelveData) return 3600;
  const active = new Set([...layout.home, ...layout.markets]);
  const fx = [...active].filter((s) => categoryOf(s) === 'forex').length;
  if (fx === 0) return null;
  const refsPerDay = active.size * (1440 / limits.referenceRefreshMinutes);
  const available = Math.max(limits.creditsPerDay * 0.9 - refsPerDay, 1);
  return Math.max(limits.fxMinPollSeconds, Math.ceil((fx * 86400) / available));
}

const categoryOf = (symbol) => server.catalog.find((i) => i.symbol === symbol)?.category;
const instrument = (symbol) => server.catalog.find((i) => i.symbol === symbol);

function badge(symbol) {
  const el = document.createElement('span');
  const base = symbol.split('/')[0];
  el.className = `badge${categoryOf(symbol) === 'metals' ? ` metal-${base}` : ''}`;
  el.textContent = base;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

// ---------------------------------------------------------------- render

/** Updates prices, changes and status in place (no re-render). */
function updateLiveValues() {
  for (const el of document.querySelectorAll('[data-price-for]')) {
    el.textContent = formatPrice(quoteFor(el.dataset.priceFor));
  }
  for (const el of document.querySelectorAll('[data-change-for]')) {
    const c = formatChange(quoteFor(el.dataset.changeFor));
    el.className = `change ${c.cls}`;
    el.textContent = c.text;
  }
  renderStatus();
  renderSaveBar();
}

function render() {
  renderStatus();
  renderHome();
  renderGroups();
  renderSaveBar();
}

function renderStatus() {
  const { status } = server;
  const box = $('status');
  box.replaceChildren();
  const pill = (label, cls = '') => {
    const p = document.createElement('span');
    p.className = 'pill';
    const dot = document.createElement('span');
    dot.className = `dot ${cls}`;
    p.append(dot, label);
    box.append(p);
  };
  const live = status.forexSource === 'Twelve Data';
  pill(
    live
      ? `Forex: Twelve Data · every ${formatDuration(status.forexPollSeconds)}`
      : 'Forex: ECB daily rates',
    live ? '' : 'warn',
  );
  pill(`Metals: gold-api · every ${formatDuration(status.metalsPollSeconds)}`);
  box.hidden = false;

  const errors = Object.entries(status.errors || {});
  $('upstreamErrors').hidden = errors.length === 0;
  $('upstreamErrors').textContent = errors.length
    ? `Upstream problems: ${errors.map(([job, msg]) => `${job} — ${msg}`).join(' · ')}`
    : '';
}

function renderHome() {
  const list = $('homeList');
  list.replaceChildren();
  const tpl = $('homeItemTpl');
  draft.home.forEach((symbol, i) => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.querySelector('.pos').textContent = i + 1;
    li.querySelector('.badge').replaceWith(badge(symbol));
    li.querySelector('.sym').textContent = symbol;
    li.querySelector('.name').textContent = instrument(symbol)?.name ?? '';
    const price = li.querySelector('.price');
    price.dataset.priceFor = symbol;
    price.textContent = formatPrice(quoteFor(symbol));

    const up = li.querySelector('.up');
    const down = li.querySelector('.down');
    up.disabled = i === 0;
    down.disabled = i === draft.home.length - 1;
    up.addEventListener('click', () => moveHome(i, -1));
    down.addEventListener('click', () => moveHome(i, 1));
    li.querySelector('.remove').addEventListener('click', () => setHome(symbol, false));
    list.append(li);
  });
  $('homeEmpty').hidden = draft.home.length > 0;
  $('homeCount').textContent = `${draft.home.length} / ${server.limits.maxHome}`;
}

function renderGroups() {
  const root = $('groups');
  root.replaceChildren();
  const groups = [
    ['forex', 'Forex'],
    ['metals', 'Metals'],
  ];
  for (const [category, label] of groups) {
    const items = server.catalog.filter((i) => i.category === category);
    const section = document.createElement('div');
    section.className = 'group';

    const head = document.createElement('div');
    head.className = 'group-head';
    const h = document.createElement('h3');
    h.textContent = label;
    const links = document.createElement('div');
    links.className = 'links';
    links.append(
      linkButton('List all on Markets', () => setMarketsFor(items, true)),
      linkButton('None', () => setMarketsFor(items, false)),
    );
    head.append(h, links);

    const table = document.createElement('table');
    table.className = 'table';
    table.innerHTML = `<thead><tr>
      <th>Instrument</th><th class="c-price">Price</th><th class="c-change">Change</th>
      <th class="c-toggle">Markets</th><th class="c-toggle">Home</th></tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const item of items) tbody.append(instrumentRow(item));
    table.append(tbody);

    section.append(head, table);
    root.append(section);
  }
}

function instrumentRow(item) {
  const q = quoteFor(item.symbol);
  const tr = document.createElement('tr');

  const inst = document.createElement('td');
  const cell = document.createElement('div');
  cell.className = 'inst-cell';
  const text = document.createElement('span');
  text.className = 'inst';
  const sym = document.createElement('span');
  sym.className = 'sym';
  sym.textContent = item.symbol;
  const name = document.createElement('span');
  name.className = 'name muted small';
  name.textContent = item.name;
  text.append(sym, name);
  cell.append(badge(item.symbol), text);
  inst.append(cell);

  const price = document.createElement('td');
  price.className = 'c-price';
  const value = document.createElement('span');
  value.dataset.priceFor = item.symbol;
  value.textContent = formatPrice(q);
  price.append(value);
  if (q?.source) {
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = q.source;
    price.append(src);
  } else if (!server.layout.home.includes(item.symbol) && !server.layout.markets.includes(item.symbol)) {
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = 'Not polled';
    price.append(src);
  }

  const change = document.createElement('td');
  change.className = 'c-change';
  const chip = document.createElement('span');
  chip.dataset.changeFor = item.symbol;
  const c = formatChange(q);
  chip.className = `change ${c.cls}`;
  chip.textContent = c.text;
  change.append(chip);

  const markets = toggleCell(
    draft.markets.includes(item.symbol),
    `Show ${item.symbol} on Markets`,
    (on) => setMarkets(item.symbol, on),
  );
  const homeFull = !draft.home.includes(item.symbol) && draft.home.length >= server.limits.maxHome;
  const home = toggleCell(
    draft.home.includes(item.symbol),
    `Show ${item.symbol} on Home`,
    (on) => setHome(item.symbol, on),
    homeFull,
  );

  tr.append(inst, price, change, markets, home);
  return tr;
}

function toggleCell(checked, label, onChange, disabled = false) {
  const td = document.createElement('td');
  td.className = 'c-toggle';
  const wrap = document.createElement('label');
  wrap.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = disabled;
  input.setAttribute('aria-label', label);
  if (disabled) wrap.title = `Home is full (max ${server.limits.maxHome})`;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.append(input, document.createElement('span'));
  td.append(wrap);
  return td;
}

function linkButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderSaveBar() {
  const dirty = isDirty();
  $('saveBar').hidden = !dirty;
  if (!dirty) return;
  if (!layoutDirty()) {
    // Only deposit settings changed; the forex budget is unaffected.
    $('budgetPreview').textContent = 'Deposit settings will be updated.';
    return;
  }
  const now = server.status.forexPollSeconds;
  const next = previewForexSeconds(draft);
  $('budgetPreview').textContent = !server.limits.twelveData
    ? 'Forex uses ECB daily rates until a Twelve Data key is set.'
    : next === now
      ? `Forex will keep refreshing every ${formatDuration(next)}.`
      : `Forex will refresh every ${formatDuration(next)} (now ${formatDuration(now)}).`;
}

// ---------------------------------------------------------- deposits

/**
 * Builds the deposit settings controls from [depositDraft]. Called once per
 * server state, not on every edit, so typing is never interrupted.
 */
function buildDepositUi() {
  $('whatsappInput').value = formatWhatsApp(depositDraft.whatsappNumber);
  $('minAmountInput').value = depositDraft.minAmount;

  const list = $('methodList');
  list.replaceChildren();
  const tpl = $('methodItemTpl');

  depositDraft.methods.forEach((method, index) => {
    const row = tpl.content.firstElementChild.cloneNode(true);
    const enabled = row.querySelector('.enabled');
    const name = row.querySelector('.method-name');
    const logoUrl = row.querySelector('.method-logo-url');
    const logo = row.querySelector('img.method-logo');
    const blank = row.querySelector('.method-logo-blank');

    enabled.checked = method.enabled;
    enabled.setAttribute('aria-label', `Offer ${method.name} in the app`);
    name.value = method.name;
    logoUrl.value = method.logoUrl;
    showLogo(logo, blank, method.logoUrl, method.name);

    enabled.addEventListener('change', () => {
      depositDraft.methods[index].enabled = enabled.checked;
      row.classList.toggle('off', !enabled.checked);
      renderDepositSummary();
    });
    name.addEventListener('input', () => {
      depositDraft.methods[index].name = name.value;
      showLogo(logo, blank, logoUrl.value, name.value);
      renderDepositSummary();
    });
    logoUrl.addEventListener('input', () => {
      depositDraft.methods[index].logoUrl = logoUrl.value.trim();
      showLogo(logo, blank, logoUrl.value.trim(), name.value);
      renderDepositSummary();
    });

    row.classList.toggle('off', !method.enabled);
    list.append(row);
  });

  renderDepositSummary();
}

/** Shows the logo image when there is a usable URL, else a name monogram. */
function showLogo(img, blank, url, name) {
  const usable = /^https?:\/\//i.test(url);
  img.hidden = !usable;
  blank.hidden = usable;
  blank.textContent = (name || '?').trim().charAt(0).toUpperCase();
  if (usable && img.src !== url) img.src = url;
  // A broken URL falls back to the monogram rather than a broken-image icon.
  img.onerror = () => {
    img.hidden = true;
    blank.hidden = false;
  };
}

function renderDepositSummary() {
  const on = depositDraft.methods.filter((m) => m.enabled).length;
  $('methodCount').textContent = `${on} of ${depositDraft.methods.length} on`;
  $('depositClosedHint').hidden = Boolean(depositDraft.whatsappNumber.trim());
  renderSaveBar();
}

/** `9647702220011` -> `+964 770 222 0011`, for the input's initial value. */
function formatWhatsApp(digits) {
  return digits ? `+${digits}` : '';
}

// --------------------------------------------------------------- editing

function setHome(symbol, on) {
  draft.home = draft.home.filter((s) => s !== symbol);
  if (on) draft.home.push(symbol);
  render();
}

function moveHome(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= draft.home.length) return;
  [draft.home[index], draft.home[target]] = [draft.home[target], draft.home[index]];
  render();
}

function setMarkets(symbol, on) {
  setMarketsFor([{ symbol }], on);
}

function setMarketsFor(items, on) {
  const symbols = new Set(items.map((i) => i.symbol));
  const kept = draft.markets.filter((s) => !symbols.has(s));
  // Keep catalogue order for Markets; the app groups by category anyway.
  const wanted = new Set(on ? [...kept, ...symbols] : kept);
  draft.markets = server.catalog.map((i) => i.symbol).filter((s) => wanted.has(s));
  render();
}

async function save() {
  const button = $('saveBtn');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    // Each section is saved only if it changed, so a bad deposit setting
    // never blocks a layout edit and vice versa.
    let state = server;
    if (layoutDirty()) {
      state = await api('/layout', { method: 'PUT', body: JSON.stringify(draft) });
    }
    if (depositDirty()) {
      state = await api('/deposit', {
        method: 'PUT',
        body: JSON.stringify(depositDraft),
      });
    }
    applyServerState(state, { resetDraft: true });
    toast('Saved. The app will update within a few seconds.');
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Save changes';
  }
}

let toastTimer;
function toast(message, bad = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast${bad ? ' bad' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ------------------------------------------------------------------ init

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button[type="submit"]');
  $('loginError').hidden = true;
  button.disabled = true;
  try {
    await openDashboard(
      await requestSession($('emailInput').value.trim(), $('passwordInput').value),
    );
    $('passwordInput').value = '';
  } catch (err) {
    if (err.message === 'unauthorized') return; // signOut() already explained it
    $('loginError').textContent = err.shown
      ? err.message
      : `Could not reach the backend: ${err.message}`;
    $('loginError').hidden = false;
    $('passwordInput').select();
  } finally {
    button.disabled = false;
  }
});
$('signOut').addEventListener('click', () => signOut());
$('saveBtn').addEventListener('click', save);
$('discardBtn').addEventListener('click', () => {
  draft = structuredClone(server.layout);
  depositDraft = structuredClone(server.deposit);
  buildDepositUi();
  render();
});

$('whatsappInput').addEventListener('input', (e) => {
  // Stored as digits; the admin may type spaces, dashes or a leading +.
  depositDraft.whatsappNumber = e.target.value.replace(/[^0-9]/g, '');
  renderDepositSummary();
});
$('minAmountInput').addEventListener('input', (e) => {
  const value = Number(e.target.value);
  depositDraft.minAmount = Number.isFinite(value) ? value : 0;
  renderSaveBar();
});
window.addEventListener('beforeunload', (e) => {
  if (server && draft && isDirty()) e.preventDefault();
});

if (token) {
  // A stored session may have expired; api() falls back to the form on 401.
  openDashboard(token).catch(() => {});
} else {
  signOut();
}

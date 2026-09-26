import { createServer } from 'node:http';
process.env.VERCEL = '1';
process.env.ADMIN_EMAIL = 'smoke@axp.test';
process.env.ADMIN_PASSWORD = 'smoke-password';
process.env.UPTRADER_API_URL = 'https://login.axp-portal.com';
const { default: handler } = await import('../api/index.js');
const server = createServer((req, res) => handler(req, res));
await new Promise((r) => server.listen(4321, r));
const base = 'http://localhost:4321';
const show = async (path, init) => {
  const res = await fetch(base + path, init);
  const text = await res.text();
  console.log(`${String(res.status).padEnd(4)} ${path} -> ${text.slice(0, 150).replace(/\n/g, ' ')}`);
};
await show('/health');
await show('/v1/quotes');
await show('/v1/deposit/config');
const login = await fetch(base + '/v1/admin/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'smoke@axp.test', password: 'smoke-password' }),
});
const { session } = await login.json();
console.log(`${String(login.status).padEnd(4)} /v1/admin/login -> session for ${session?.email}`);
await show('/v1/admin/state', { headers: { authorization: `Bearer ${session.token}` } });
await show('/v1/admin/state', { headers: { authorization: 'Bearer wrong' } });
await show('/portal/nope');
await show('/admin/');
server.close();
process.exit(0);

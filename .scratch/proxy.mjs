import { createServer } from 'node:http';
process.env.VERCEL = '1';
process.env.ADMIN_EMAIL = 'smoke@axp.test';
process.env.ADMIN_PASSWORD = 'smoke-password';
process.env.UPTRADER_API_URL = 'https://login.axp-portal.com';
const { default: handler } = await import('../api/index.js');
const server = createServer((req, res) => handler(req, res));
await new Promise((r) => server.listen(4322, r));
const base = 'http://localhost:4322';

// A GET the portal answers without a session, proving pass-through.
let res = await fetch(base + '/portal/api/utils/broker_metadata/');
console.log('GET  broker_metadata ->', res.status, (await res.text()).slice(0, 120));

// A POST with a body, proving the body survives untouched.
res = await fetch(base + '/portal/api/auth/get_otp_token/', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ emailOrPhone: 'nobody@example.com', password: 'x', rememberMe: true }),
});
console.log('POST get_otp_token  ->', res.status, (await res.text()).slice(0, 120));
console.log('CORS header         ->', res.headers.get('access-control-allow-origin'));

// Preflight, which is what a browser sends first.
res = await fetch(base + '/portal/api/auth/get_otp_token/', { method: 'OPTIONS' });
console.log('OPTIONS preflight   ->', res.status, res.headers.get('access-control-allow-headers'));
server.close();
process.exit(0);

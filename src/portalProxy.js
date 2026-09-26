import express from 'express';

/**
 * A same-origin pass-through to the AXP portal, so the Flutter **web** build
 * can reach it.
 *
 * On mobile and desktop the app calls login.axp-portal.com directly and this
 * is unused. A browser cannot: the portal only allows its own origin, so
 * every call — sign-in, accounts, KYC, payments — is blocked by CORS before
 * it is even sent. Pointing the web build at this proxy
 * (`--dart-define=PORTAL_BASE_URL=https://<host>/portal`) makes those calls
 * same-origin from the browser's point of view.
 *
 * It forwards nothing of its own: no credentials are added here, and the
 * only authorisation is the caller's own `JWT <token>` header, exactly as
 * the app would have sent it. The target host is fixed and only `/api/…`
 * paths are forwarded, so this cannot be used as an open relay.
 */
export function createPortalProxy(portalBaseUrl, { fetchImpl = fetch } = {}) {
  const router = express.Router();
  const base = (portalBaseUrl || '').replace(/\/+$/, '');

  const cors = (req, res, next) => {
    res.set({
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, accept, locale',
      'access-control-max-age': '86400',
      'cache-control': 'no-store',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
  router.use(cors);

  if (!base) {
    return router.use((req, res) =>
      res.status(501).json({ error: 'The portal proxy is not configured.' }),
    );
  }

  // Bodies are passed through untouched — multipart KYC uploads must keep
  // their exact boundaries, so nothing here parses or re-encodes them.
  router.use(express.raw({ type: '*/*', limit: '25mb' }));

  router.use(async (req, res) => {
    // Only the portal's JSON/API surface, never its pages or assets.
    if (!req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found.' });
    }

    const headers = {};
    // An allowlist: hop-by-hop headers and anything identifying this server
    // must not be relayed.
    for (const name of ['authorization', 'content-type', 'accept', 'locale']) {
      const value = req.get(name);
      if (value) headers[name] = value;
    }

    const hasBody = !['GET', 'HEAD'].includes(req.method);
    try {
      const upstream = await fetchImpl(`${base}${req.originalUrl.replace(/^\/portal/, '')}`, {
        method: req.method,
        headers,
        body: hasBody && req.body?.length ? req.body : undefined,
        redirect: 'manual',
      });

      const type = upstream.headers.get('content-type');
      if (type) res.set('content-type', type);
      res.status(upstream.status);
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      console.error(`[portal-proxy] ${req.method} ${req.path}: ${err.message}`);
      res.status(502).json({ error: 'The user portal could not be reached.' });
    }
  });

  return router;
}

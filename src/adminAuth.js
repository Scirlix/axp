import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Dashboard sign-in: an email and a password, in place of the shared token
 * this used to take.
 *
 * Sessions are stateless. Signing in returns `<claims>.<signature>`, where the
 * signature is an HMAC keyed on the configured credentials themselves. Nothing
 * is kept server-side, which is what makes it work on Vercel: every cold start
 * derives the same key, so a token one instance issued is accepted by the
 * next. Changing the password invalidates the sessions already out there,
 * because the key changes with it.
 */

const SESSION_MS = 12 * 60 * 60 * 1000;

const sha256 = (value) => createHash('sha256').update(value).digest();
const sameDigest = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
const b64 = (value) => Buffer.from(value).toString('base64url');

export class AdminAuth {
  #emailDigest;
  #passwordDigest;
  #key;

  /** @param {{ email?: string, password?: string, sessionMs?: number }} credentials */
  constructor({ email, password, sessionMs = SESSION_MS } = {}) {
    this.email = normalizeEmail(email);
    this.sessionMs = sessionMs;
    this.configured = Boolean(this.email && password);
    this.#emailDigest = sha256(this.email);
    this.#passwordDigest = sha256(String(password ?? ''));
    // Derived from the credentials so no second secret has to be configured,
    // and prefixed so the key can never collide with another use of them.
    this.#key = sha256(`axp-admin-session\n${this.email}\n${password ?? ''}`);
  }

  /**
   * @returns {{ token: string, email: string, expiresAt: string } | null}
   *   null when the credentials do not match.
   */
  signIn(email, password) {
    if (!this.configured) return null;
    // Both digests are compared every time, so a reply takes the same time
    // whether it was the email or the password that was wrong.
    const emailOk = sameDigest(sha256(normalizeEmail(email)), this.#emailDigest);
    const passwordOk = sameDigest(sha256(String(password ?? '')), this.#passwordDigest);
    if (!emailOk || !passwordOk) return null;

    const exp = Date.now() + this.sessionMs;
    const claims = b64(JSON.stringify({ sub: this.email, exp }));
    return {
      token: `${claims}.${b64(this.#sign(claims))}`,
      email: this.email,
      expiresAt: new Date(exp).toISOString(),
    };
  }

  /** @returns {{ sub: string, exp: number } | null} for a live session token. */
  verify(token) {
    if (!this.configured || typeof token !== 'string') return null;
    const [claims, signature] = token.split('.');
    if (!claims || !signature) return null;
    if (!sameDigest(Buffer.from(signature, 'base64url'), this.#sign(claims))) return null;

    let payload;
    try {
      payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
    } catch {
      return null; // signed, so this should not happen — treat it as invalid.
    }
    if (typeof payload?.exp !== 'number' || payload.exp <= Date.now()) return null;
    return payload;
  }

  #sign(claims) {
    return createHmac('sha256', this.#key).update(claims).digest();
  }
}

/**
 * Slows password guessing: after [limit] failures from one address, that
 * address waits out [windowMs]. Held in memory, so on a serverless host it
 * only covers the instance that saw the attempts — enough to make guessing
 * over the network impractical, not a substitute for a good password.
 */
export class LoginThrottle {
  constructor({ limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.attempts = new Map();
  }

  /** Seconds the caller must wait, or 0 when it may try now. */
  retryAfter(key, now = Date.now()) {
    const entry = this.attempts.get(key);
    if (!entry || entry.until <= now || entry.count < this.limit) return 0;
    return Math.ceil((entry.until - now) / 1000);
  }

  fail(key, now = Date.now()) {
    const entry = this.attempts.get(key);
    const stale = !entry || entry.until <= now;
    this.attempts.set(key, {
      count: stale ? 1 : entry.count + 1,
      until: now + this.windowMs,
    });
    // Keeps the map from growing without bound on a long-lived instance.
    if (this.attempts.size > 1000) {
      for (const [k, e] of this.attempts) if (e.until <= now) this.attempts.delete(k);
    }
  }

  succeed(key) {
    this.attempts.delete(key);
  }
}

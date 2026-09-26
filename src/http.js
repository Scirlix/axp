export class UpstreamError extends Error {
  constructor(source, message) {
    super(`${source}: ${message}`);
    this.source = source;
  }
}

// gold-api.com rejects generic/default user agents with HTTP 429.
const USER_AGENT = 'AXP-Analytics-Backend/1.0';

/**
 * GETs JSON with a timeout. `fetchImpl` is injectable for tests.
 * Throws UpstreamError on network errors and non-2xx responses.
 */
export async function getJson(fetchImpl, source, url, timeoutMs = 10_000) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new UpstreamError(source, err.name === 'TimeoutError' ? 'timeout' : err.message);
  }
  if (!res.ok) throw new UpstreamError(source, `HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new UpstreamError(source, 'invalid JSON');
  }
}

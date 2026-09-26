import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Where the dashboard's settings live.
 *
 * Locally that is a JSON file. On Vercel it cannot be: the deployment's
 * filesystem is read-only apart from /tmp, and /tmp is per-instance and
 * thrown away, so a saved layout would fail to write or quietly disappear on
 * the next cold start. A Redis REST store (Upstash, including the one
 * Vercel provisions) is used instead when its environment variables exist.
 *
 * Both backends expose the same two calls, so the stores above them do not
 * care which one they got.
 */

/**
 * A save that could not be persisted. Its message is written for the admin
 * reading it in the dashboard, so routes pass it straight through.
 */
export class StorageError extends Error {}

/** A JSON file on disk. Used for local development and `npm start`. */
export class FileStorage {
  constructor(path) {
    this.path = path;
    this.description = path;
  }

  async read() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(value) {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      // Write-then-rename so a crash never leaves a half-written file.
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
      await rename(tmp, this.path);
    } catch (err) {
      // On Vercel everything outside /tmp is read-only, so this is what a
      // save hits when no Redis store is configured. Saying so beats the
      // generic 500 the admin used to get.
      throw new StorageError(
        isServerless()
          ? 'Settings cannot be saved: this deployment has no storage. Add a ' +
            'Redis store (Vercel → Storage → Upstash), then redeploy.'
          : `Settings could not be written to ${this.path}: ${err.message}`,
      );
    }
  }
}

/**
 * A key in a Redis-compatible REST store (Upstash / Vercel KV).
 *
 * Uses the REST API rather than a Redis client on purpose: serverless
 * invocations are short and a pooled TCP connection has nowhere to live
 * between them.
 */
export class RedisStorage {
  constructor(key, { url, token, fetchImpl = fetch }) {
    this.key = key;
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.description = `redis:${key}`;
  }

  async #command(...parts) {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(parts),
    });
    if (!res.ok) {
      throw new Error(`Redis ${parts[0]} failed (HTTP ${res.status}).`);
    }
    const body = await res.json();
    if (body.error) throw new Error(`Redis ${parts[0]} failed: ${body.error}`);
    return body.result;
  }

  async read() {
    const raw = await this.#command('GET', this.key);
    if (raw == null || raw === '') return null;
    // Upstash returns the stored string; a client may have stored an object.
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  async write(value) {
    try {
      await this.#command('SET', this.key, JSON.stringify(value));
    } catch (err) {
      throw new StorageError(`Settings could not be saved: ${err.message}`);
    }
  }
}

/** True when running as a Vercel serverless function. */
export const isServerless = (env = process.env) => Boolean(env.VERCEL);

/**
 * Picks a backend for [key], falling back to the file at [path].
 *
 * Accepts either of the two names the Redis integrations use: `KV_REST_API_*`
 * (what Vercel injects) and `UPSTASH_REDIS_REST_*` (Upstash's own).
 */
export function pickStorage(key, path, env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new RedisStorage(key, { url, token });
  return new FileStorage(path);
}

/**
 * Warns when settings are about to be kept somewhere that will not survive.
 * Returns true when persistence is real.
 */
export function checkPersistence(storage, env = process.env) {
  const durable = storage instanceof RedisStorage || !isServerless(env);
  if (!durable) {
    console.warn(
      '[storage] Running on Vercel with no Redis store configured.\n' +
        '          Dashboard changes will apply to the running instance only\n' +
        '          and are lost on the next cold start. Add a Redis store\n' +
        '          (Storage tab -> Upstash) to keep them.',
    );
  }
  return durable;
}

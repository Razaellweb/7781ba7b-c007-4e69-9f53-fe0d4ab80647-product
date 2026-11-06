import { redisConfig } from "./config";

export class RedisError extends Error {
  readonly code = "REDIS_ERROR";
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "RedisError"; }
}

// Upstash Redis REST transport. Each call is a single HTTPS request of the form
// POST {url} with a JSON command array and a Bearer token. This works on every
// serverless/IPv4 runtime, unlike a raw redis:// socket.
const REDIS_TIMEOUT_MS = 3000;

async function command<T = unknown>(args: (string | number)[]): Promise<T> {
  const config = redisConfig();
  if (!config.enabled || !config.url || !config.token) throw new RedisError("Redis is not configured");
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
    // A hung Redis must not stall the request it guards.
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
  });
  if (!response.ok) throw new RedisError(`Redis command failed with status ${response.status}`);
  const payload = await response.json() as { result?: T; error?: string };
  if (payload.error) throw new RedisError(payload.error);
  return payload.result as T;
}

const key = (value: string) => `${redisConfig().keyPrefix}${value}`;

export function redisEnabled(): boolean { return redisConfig().enabled; }

export async function cacheGet<T>(name: string): Promise<T | null> {
  if (!redisEnabled()) return null;
  try {
    const raw = await command<string | null>(["GET", key(name)]);
    return raw ? JSON.parse(raw) as T : null;
  } catch (e) { throw new RedisError("Transient cache operation failed", { cause: e }); }
}

export async function cacheSet(name: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!redisEnabled()) return;
  if (ttlSeconds <= 0) throw new RedisError("Redis TTL must be positive");
  try { await command(["SET", key(name), JSON.stringify(value), "EX", ttlSeconds]); }
  catch (e) { throw new RedisError("Transient cache operation failed", { cause: e }); }
}

// Fixed-window rate limiter. Enforced whenever Upstash answers. Fails OPEN when
// Redis is unconfigured or unreachable (e.g. a deleted database), so an outage of
// this guard never takes inference down; spending stays bounded by the prepaid
// balance and each request's reservation cap.
export async function rateLimit(name: string, limit: number, windowSeconds: number): Promise<boolean> {
  if (!redisEnabled()) return true;
  try {
    const count = await command<number>(["INCR", key(`rate:${name}`)]);
    if (count === 1) await command(["EXPIRE", key(`rate:${name}`), windowSeconds]);
    return count <= limit;
  } catch (e) {
    console.warn(JSON.stringify({ event: "rate_limit_unavailable", limiter: name.split(":").slice(0, 2).join(":"), error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
    return true;
  }
}

const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

// Best-effort distributed lock. When Redis is unavailable the work still runs
// (single-region correctness is guaranteed by the SQL FOR UPDATE in accounting).
export async function withLock<T>(name: string, ttlSeconds: number, work: () => Promise<T>): Promise<T> {
  if (!redisEnabled()) return work();
  const lockKey = key(`lock:${name}`);
  const token = crypto.randomUUID();
  const acquired = await command<string | null>(["SET", lockKey, token, "NX", "EX", ttlSeconds]).catch(() => null);
  if (!acquired) throw new RedisError("Coordination lock unavailable");
  try { return await work(); }
  finally { await command(["EVAL", RELEASE, 1, lockKey, token]).catch(() => undefined); }
}

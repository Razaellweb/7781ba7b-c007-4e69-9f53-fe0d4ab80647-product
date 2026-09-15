import { createClient, type RedisClientType } from "redis";
import { redisConfig } from "./config";

export class RedisError extends Error {
  readonly code = "REDIS_ERROR";
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "RedisError"; }
}
let client: RedisClientType | undefined;
async function getRedis() {
  if (!client) { const config = redisConfig(); client = createClient({ url: config.url }); client.on("error", () => undefined); }
  if (!client.isOpen) await client.connect();
  return client;
}
const key = (value: string) => `${redisConfig().keyPrefix}${value}`;
export async function cacheGet<T>(name: string): Promise<T | null> { try { const raw = await getRedis().then(c => c.get(key(name))); return raw ? JSON.parse(raw) as T : null; } catch (e) { throw new RedisError("Transient cache operation failed", { cause: e }); } }
export async function cacheSet(name: string, value: unknown, ttlSeconds: number): Promise<void> { if (ttlSeconds <= 0) throw new RedisError("Redis TTL must be positive"); try { await getRedis().then(c => c.set(key(name), JSON.stringify(value), { EX: ttlSeconds })); } catch (e) { throw new RedisError("Transient cache operation failed", { cause: e }); } }
export async function rateLimit(name: string, limit: number, windowSeconds: number): Promise<boolean> { try { const c = await getRedis(); const count = await c.incr(key(`rate:${name}`)); if (count === 1) await c.expire(key(`rate:${name}`), windowSeconds); return count <= limit; } catch (e) { throw new RedisError("Rate-limit coordination unavailable", { cause: e }); } }
export async function withLock<T>(name: string, ttlSeconds: number, work: () => Promise<T>): Promise<T> { const c = await getRedis(); const lockKey = key(`lock:${name}`); const token = crypto.randomUUID(); const acquired = await c.set(lockKey, token, { NX: true, EX: ttlSeconds }); if (!acquired) throw new RedisError("Coordination lock unavailable"); try { return await work(); } finally { await c.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", { keys: [lockKey], arguments: [token] }).catch(() => undefined); } }

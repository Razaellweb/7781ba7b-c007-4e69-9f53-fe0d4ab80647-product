import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "./db";

const KEY_PATTERN = /^ow_live_[A-Za-z0-9_-]{43}$/;
const MAX_KEYS_PER_ACCOUNT = 20;
const DEFAULT_SCOPES = ["chat:write", "account:read"];
const CHAT_SCOPE = "chat:write";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_COLUMNS = "id,account_id,name,secret_hash,scopes,rate_limit_per_minute,created_at,last_used_at,revoked_at";

type KeyRow = {
  id: string;
  account_id: string;
  name: string;
  secret_hash: string;
  scopes: string[];
  rate_limit_per_minute: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export class ApiKeyError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export type ApiKeyMetadata = Omit<KeyRow, "secret_hash" | "account_id"> & { key_prefix: "ow_live" };

/** Public, non-secret identity of a key that authorized a first-party request. */
export type ActiveAccountKey = {
  id: string;
  name: string;
  scopes: string[];
  rateLimitPerMinute: number;
  createdAt: string;
  lastUsedAt: string | null;
};

function hashSecret(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function publicMetadata(row: KeyRow): ApiKeyMetadata {
  return {
    id: row.id,
    name: row.name,
    key_prefix: "ow_live",
    scopes: row.scopes,
    rate_limit_per_minute: row.rate_limit_per_minute,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

function normalizeName(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new ApiKeyError("EMPTY_NAME", "A key name is required");
  const name = value.trim();
  if (name.length > 80) throw new ApiKeyError("INVALID_NAME", "Key names must be 80 characters or fewer");
  return name;
}

function normalizeScopes(value: unknown) {
  if (value == null) return DEFAULT_SCOPES;
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string" || !/^[a-z]+:[a-z]+$/.test(scope))) {
    throw new ApiKeyError("INVALID_SCOPES", "Scopes are invalid");
  }
  const scopes = [...new Set(value)];
  if (!scopes.length) throw new ApiKeyError("INVALID_SCOPES", "At least one scope is required");
  return scopes;
}

function generation(input: { name?: unknown; scopes?: unknown; rateLimitPerMinute?: unknown }) {
  const name = normalizeName(input.name);
  const scopes = normalizeScopes(input.scopes);
  const rate = input.rateLimitPerMinute == null ? 60 : Number(input.rateLimitPerMinute);
  if (!Number.isInteger(rate) || rate < 1 || rate > 1000) {
    throw new ApiKeyError("INVALID_RATE_LIMIT", "Rate limit must be an integer from 1 to 1000 per minute");
  }
  const secret = `ow_live_${randomBytes(32).toString("base64url")}`;
  return { name, scopes, rate, secret, hash: hashSecret(secret) };
}

function databaseCode(error: unknown): string | undefined {
  let current: unknown = error;
  let postgresCode: string | undefined;
  while (current instanceof Error) {
    if (current instanceof ApiKeyError) throw current;
    const candidate = current as Error & { code?: string; cause?: unknown };
    if (candidate.code && candidate.code !== "DATABASE_ERROR") postgresCode = candidate.code;
    current = candidate.cause;
  }
  return postgresCode;
}

function handleWriteError(error: unknown): never {
  if (error instanceof ApiKeyError) throw error;
  if (databaseCode(error) === "23505") {
    throw new ApiKeyError("DUPLICATE_NAME", "A key with that name already exists", 409);
  }
  throw error;
}

async function insertKey(
  db: PoolClient,
  accountId: string,
  input: { name?: unknown; scopes?: unknown; rateLimitPerMinute?: unknown },
) {
  const generated = generation(input);
  const result = await db.query<KeyRow>(
    `INSERT INTO api_keys (account_id,name,key_prefix,secret_hash,scopes,rate_limit_per_minute)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id,account_id,name,secret_hash,scopes,rate_limit_per_minute,created_at,last_used_at,revoked_at`,
    [accountId, generated.name, "ow_live", generated.hash, generated.scopes, generated.rate],
  );
  return { secret: generated.secret, key: publicMetadata(result.rows[0]) };
}

export async function createApiKey(
  accountId: string,
  input: { name?: unknown; scopes?: unknown; rateLimitPerMinute?: unknown },
) {
  try {
    return await transaction(async (db) => {
      const count = await db.query<{ count: string }>(
        "SELECT count(*)::text count FROM api_keys WHERE account_id=$1 AND revoked_at IS NULL",
        [accountId],
      );
      if (Number(count.rows[0]?.count ?? 0) >= MAX_KEYS_PER_ACCOUNT) {
        throw new ApiKeyError("KEY_LIMIT_REACHED", "This account has reached the maximum number of active API keys", 409);
      }
      return insertKey(db, accountId, input);
    });
  } catch (error) {
    return handleWriteError(error);
  }
}

export async function rotateApiKey(
  accountId: string,
  id: string,
  input: { name?: unknown; scopes?: unknown; rateLimitPerMinute?: unknown },
) {
  try {
    return await transaction(async (db) => {
      const old = await db.query<KeyRow>(
        "SELECT id,account_id,name,secret_hash,scopes,rate_limit_per_minute,created_at,last_used_at,revoked_at FROM api_keys WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL FOR UPDATE",
        [id, accountId],
      );
      if (!old.rows.length) throw new ApiKeyError("KEY_NOT_FOUND", "API key could not be rotated", 404);
      const replacement = await insertKey(db, accountId, input);
      await db.query("UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL", [id, accountId]);
      return replacement;
    });
  } catch (error) {
    return handleWriteError(error);
  }
}

export async function listApiKeys(accountId: string) {
  const rows = await query<KeyRow>(
    `SELECT id,account_id,name,secret_hash,scopes,rate_limit_per_minute,created_at,last_used_at,revoked_at
     FROM api_keys WHERE account_id=$1 ORDER BY created_at DESC`,
    [accountId],
  );
  return rows.map(publicMetadata);
}

export async function revokeApiKey(accountId: string, id: string) {
  const rows = await query<{ id: string }>(
    `UPDATE api_keys SET revoked_at=COALESCE(revoked_at,now())
     WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL RETURNING id`,
    [id, accountId],
  );
  if (!rows.length) throw new ApiKeyError("KEY_NOT_FOUND", "API key could not be revoked", 404);
  return { revoked: true };
}

/**
 * Resolves the account-owned API key that authorizes a first-party request such
 * as the Playground. Ownership, revocation state, and the chat:write scope are
 * all read from the database on every call, so a revoked key, another account's
 * key, or purely client-side state can never authorize a request.
 */
export async function requireActiveAccountKey(accountId: string, keyId?: string | null): Promise<ActiveAccountKey> {
  const requested = typeof keyId === "string" && keyId.trim() ? keyId.trim() : null;
  if (requested && !UUID_PATTERN.test(requested)) {
    throw new ApiKeyError("API_KEY_NOT_FOUND", "That API key does not belong to this account", 403);
  }
  const rows = requested
    ? await query<KeyRow>(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id=$1 AND account_id=$2 LIMIT 1`, [requested, accountId])
    : await query<KeyRow>(
      `SELECT ${KEY_COLUMNS} FROM api_keys
       WHERE account_id=$1 AND revoked_at IS NULL AND $2 = ANY(scopes)
       ORDER BY created_at DESC LIMIT 1`,
      [accountId, CHAT_SCOPE],
    );
  const row = rows[0];
  if (!row) throw new ApiKeyError("API_KEY_REQUIRED", "You need an API key to use the Playground", 403);
  if (row.revoked_at) throw new ApiKeyError("API_KEY_REVOKED", "That API key has been revoked. Create a new key to keep using the Playground.", 403);
  if (!row.scopes.includes(CHAT_SCOPE)) throw new ApiKeyError("API_KEY_SCOPE", "That API key cannot make chat requests", 403);
  await query("UPDATE api_keys SET last_used_at=now() WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL", [row.id, accountId]);
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    rateLimitPerMinute: row.rate_limit_per_minute,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export async function authenticateApiKey(authorization: string | null, requiredScope?: string) {
  if (!authorization || !/^Bearer [^\s]+$/.test(authorization)) {
    throw new ApiKeyError("MALFORMED_BEARER", "A first-party API key is required", 401);
  }
  const secret = authorization.slice(7);
  if (!KEY_PATTERN.test(secret)) throw new ApiKeyError("INVALID_API_KEY", "The API key is invalid or unavailable", 401);
  const digest = hashSecret(secret);
  const rows = await query<KeyRow>(
    `SELECT id,account_id,name,secret_hash,scopes,rate_limit_per_minute,created_at,last_used_at,revoked_at
     FROM api_keys WHERE secret_hash=$1 LIMIT 1`,
    [digest],
  );
  const row = rows[0];
  const hashesMatch = row ? timingSafeEqual(Buffer.from(row.secret_hash, "hex"), Buffer.from(digest, "hex")) : false;
  if (!row || !hashesMatch || row.revoked_at) {
    throw new ApiKeyError("INVALID_API_KEY", "The API key is invalid or unavailable", 401);
  }
  if (requiredScope && !row.scopes.includes(requiredScope)) {
    throw new ApiKeyError("INSUFFICIENT_SCOPE", "The API key does not have the required scope", 403);
  }
  await query("UPDATE api_keys SET last_used_at=now() WHERE id=$1 AND revoked_at IS NULL", [row.id]);
  return { accountId: row.account_id, apiKeyId: row.id, scopes: row.scopes, rateLimitPerMinute: row.rate_limit_per_minute };
}

export function redactAuthorization(value: string | null) {
  return value?.startsWith("Bearer ") ? "Bearer [REDACTED]" : value;
}

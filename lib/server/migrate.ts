import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "./db";

export async function migrate(): Promise<void> {
  const db = getDb();
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const version = "001_foundation";
  const applied = await db.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version = $1", [version]);
  if (applied.rowCount) return;
  const sql = await readFile(join(process.cwd(), "db/migrations/001_foundation.sql"), "utf8");
  const client = await db.connect();
  try { await client.query("BEGIN"); await client.query(sql); await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]); await client.query("COMMIT"); }
  catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

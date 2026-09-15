import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "./db";

// Applies every db/migrations/*.sql file exactly once, in filename order,
// each inside its own transaction and recorded in schema_migrations. This
// replaces the previous runner that only ever applied 001_foundation.sql.
export async function migrate(): Promise<void> {
  const db = getDb();
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");

  const dir = join(process.cwd(), "db/migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const already = await db.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version = $1", [version]);
    if (already.rowCount) continue;
    const sql = await readFile(join(dir, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

let migrated: Promise<void> | undefined;
// Idempotent, memoized entrypoint safe to call from request paths.
export function ensureMigrated(): Promise<void> {
  if (!migrated) migrated = migrate().catch((error) => { migrated = undefined; throw error; });
  return migrated;
}

import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { databaseConfig } from "./config";

let pool: Pool | undefined;
export class DatabaseError extends Error {
  readonly code = "DATABASE_ERROR";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseError";
  }
}

export function getDb(): Pool {
  if (!pool) pool = new Pool(databaseConfig());
  return pool;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  try { return (await getDb().query<T>(text, values)).rows; }
  catch (error) { throw new DatabaseError("Durable datastore operation failed", { cause: error }); }
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new DatabaseError("Durable transaction rolled back", { cause: error });
  } finally { client.release(); }
}

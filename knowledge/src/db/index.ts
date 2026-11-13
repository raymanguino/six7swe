import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type KnowledgeDb = PostgresJsDatabase<typeof schema>;

/** The handle a `db.transaction(...)` callback receives. */
export type KnowledgeTx = Parameters<Parameters<KnowledgeDb['transaction']>[0]>[0];

/** Anything that can run a query: the pool or an open transaction. */
export type KnowledgeExecutor = KnowledgeDb | KnowledgeTx;

export interface DbHandle {
  db: KnowledgeDb;
  close: () => Promise<void>;
}

/**
 * Opens the database connection.
 *
 * Created explicitly rather than at import time, so tests and scripts decide
 * when (and whether) a connection exists.
 *
 * `prepare: false` turns off named prepared statements. Supabase's
 * transaction pooler (port 6543) hands each transaction to any backend
 * connection, where a statement prepared on another one does not exist; with
 * it off, DATABASE_URL may point at the transaction pooler, the session
 * pooler or a direct connection. The cost is a re-plan per query, which is
 * negligible at this service's volume.
 */
export function createDb(databaseUrl: string): DbHandle {
  const client = postgres(databaseUrl, { max: 5, prepare: false });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}

export { schema };

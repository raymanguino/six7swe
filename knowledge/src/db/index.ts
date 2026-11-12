import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type KnowledgeDb = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: KnowledgeDb;
  close: () => Promise<void>;
}

/**
 * Opens the database connection.
 *
 * Created explicitly rather than at import time, so tests and scripts decide
 * when (and whether) a connection exists.
 */
export function createDb(databaseUrl: string): DbHandle {
  const client = postgres(databaseUrl, { max: 5 });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
}

export { schema };

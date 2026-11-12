import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Where the migration ledger lives. Not `knowledge` itself (the migrator
 * would create that schema before the first migration's `CREATE SCHEMA`), and
 * not the shared `drizzle` schema, which the backend's `db:reset` drops.
 */
export const MIGRATIONS_SCHEMA = 'knowledge_migrations';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

export default defineConfig({
  // Migrations are generated from src/db/schema.ts and never edited by hand,
  // except the custom ones created with `drizzle-kit generate --custom`.
  out: './migrations',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  // Only the `knowledge` schema is ever introspected or diffed, so this
  // service can never propose changes to the backend's `public` tables.
  schemaFilter: ['knowledge'],
  migrations: {
    schema: MIGRATIONS_SCHEMA,
    table: MIGRATIONS_TABLE,
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});

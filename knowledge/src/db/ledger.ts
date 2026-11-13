/**
 * Where the migration ledger lives. Not `knowledge` itself (the migrator
 * would create that schema before the first migration's `CREATE SCHEMA`), and
 * not the shared `drizzle` schema, which the backend's `db:reset` drops.
 *
 * Shared by `drizzle.config.ts` (drizzle-kit) and `src/db/migrate.ts` (the
 * runtime migrator), so the two always agree.
 */
export const MIGRATIONS_SCHEMA = 'knowledge_migrations';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

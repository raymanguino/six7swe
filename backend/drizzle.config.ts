import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

// drizzle-kit (migrate, studio) connects as the table owner. DATABASE_URL is the backend's
// runtime role, which cannot change the schema, so the owner's DATABASE_MIGRATION_URL wins when it
// is set; locally both are usually the same `postgres` user and only DATABASE_URL is set.
const databaseUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL environment variable is required.');
}

export default defineConfig({
  // Migrations are generated from the schema in src/db/schema/ and applied in
  // order. The generated SQL is never edited by hand: change the schema and
  // run `pnpm run db:generate` instead.
  out: './migrations',
  schema: './src/db/schema/index.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
});

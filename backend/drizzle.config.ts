import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required.');
}

export default defineConfig({
  // Migrations are generated from the schema in src/db/schema/ and applied in
  // order. The generated SQL is never edited by hand: change the schema and
  // run `pnpm run db:generate` instead.
  out: './migrations',
  schema: './src/db/schema/index.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: DATABASE_URL,
  },
});

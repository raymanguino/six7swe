import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required.');
}

export default defineConfig({
  // There are no migration files. The schema in src/db/schema/ is the single
  // source of truth and `drizzle-kit push` reconciles the database with it.
  // `out` is still required by drizzle-kit, but nothing is generated into it.
  out: './drizzle',
  schema: './src/db/schema/index.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: DATABASE_URL,
  },
});

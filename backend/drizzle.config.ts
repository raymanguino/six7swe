import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

const {
  DATABASE_URL,
  DATABASE_MIGRATIONS_DIR = './migrations',
} = process.env;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required.');
}

export default defineConfig({
  out: DATABASE_MIGRATIONS_DIR,
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: DATABASE_URL,
  },
});

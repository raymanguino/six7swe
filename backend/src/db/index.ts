import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// ============================================================
// DATABASE CONNECTION
// ============================================================

const {
  DATABASE_URL,
} = process.env;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required.');
}

// Create postgres.js client
const client = postgres(DATABASE_URL);

// Create Drizzle instance with schema
export const db = drizzle(client, { schema });

// Export schema for external use
export * from './schema';

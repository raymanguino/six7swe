/**
 * The database behind `lockdown.integration.test.ts`: the local Supabase
 * Postgres, or `LOCKDOWN_TEST_DATABASE_URL`.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const ADMIN_URL =
  process.env.LOCKDOWN_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:54322/postgres';

export interface Credentials {
  role: string;
  password: string;
}

export const credentials = (role: string): Credentials => ({
  role,
  password: randomBytes(32).toString('hex'),
});

/** The admin URL pointed at another database, optionally as another role. */
export function databaseUrl(database: string, as?: Credentials): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (as) {
    url.username = as.role;
    url.password = as.password;
  }
  return url.toString();
}

/**
 * Why the database cannot be used, or null when it can: it must answer and
 * have the `anon` role (Supabase). Runs in a child process because Jest has
 * to decide synchronously whether to skip.
 */
export function probeDatabase(): string | null {
  const script = `
    const mod = require('postgres');
    const sql = (mod.default ?? mod)(process.env.PROBE_URL, { max: 1, connect_timeout: 3, onnotice() {} });
    sql\`select to_regrole('anon') is not null as anon\`
      .then(async ([row]) => { await sql.end({ timeout: 1 }); process.exit(row.anon ? 0 : 2); })
      .catch(() => process.exit(1));`;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, PROBE_URL: ADMIN_URL },
    timeout: 10_000,
  });
  if (result.status === 0) return null;
  return result.status === 2 ? 'not Supabase (no anon role)' : 'unreachable';
}

/**
 * The database behind the `lockdown*.integration.test.ts` suites: the local
 * Supabase Postgres, or `LOCKDOWN_TEST_DATABASE_URL`. Each suite works in a
 * throwaway database. Skipped when no Supabase Postgres answers;
 * `LOCKDOWN_TEST_REQUIRED=1` makes that a failure.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';

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

const unavailable = probeDatabase();

/** `describe` when the database answers (or is required), else `describe.skip`. */
export const describeWithDatabase =
  unavailable === null || process.env.LOCKDOWN_TEST_REQUIRED === '1' ? describe : describe.skip;

/** Unique per run, so suites and repeated runs never collide. */
export const runSuffix = (): string => `${process.pid}_${randomBytes(3).toString('hex')}`;

export interface TestDatabase {
  /** The cluster, as the admin. */
  readonly admin: postgres.Sql;
  /** The throwaway database, as the table owner. */
  readonly owner: postgres.Sql;
  connect(as: Credentials): postgres.Sql;
  asRole<T>(as: Credentials, fn: (sql: postgres.Sql) => Promise<T>): Promise<T>;
}

/**
 * Registers hooks that create a throwaway database, create `logins`, run
 * `setup` as the owner, and afterwards drop the database and every role in
 * `drop`, even when a step fails.
 */
export function useTestDatabase(
  database: string,
  setup: string,
  logins: Credentials[],
  drop: Credentials[],
): TestDatabase {
  const quiet = { max: 1, onnotice: () => undefined };
  let admin: postgres.Sql | undefined;
  let owner: postgres.Sql | undefined;
  const ready = (sql: postgres.Sql | undefined): postgres.Sql => {
    if (!sql) throw new Error('The test database is not set up.');
    return sql;
  };
  const connect = (as?: Credentials): postgres.Sql => postgres(databaseUrl(database, as), quiet);

  beforeAll(async () => {
    if (unavailable !== null) {
      throw new Error(`LOCKDOWN_TEST_REQUIRED=1 but the database is ${unavailable}.`);
    }
    admin = postgres(ADMIN_URL, quiet);
    await admin.unsafe(`create database "${database}"`);
    for (const login of logins) {
      await admin.unsafe(`create role "${login.role}" login password '${login.password}'`);
    }
    owner = connect();
    await owner.unsafe(setup);
  }, 30_000);

  afterAll(async () => {
    try {
      await owner?.end();
    } finally {
      try {
        await admin?.unsafe(`drop database if exists "${database}" with (force)`);
      } finally {
        try {
          for (const { role } of drop) {
            await admin?.unsafe(`drop role if exists "${role}"`);
          }
        } finally {
          await admin?.end();
        }
      }
    }
  }, 30_000);

  return {
    get admin() {
      return ready(admin);
    },
    get owner() {
      return ready(owner);
    },
    connect,
    async asRole(as, fn) {
      const sql = connect(as);
      try {
        return await fn(sql);
      } finally {
        await sql.end();
      }
    },
  };
}

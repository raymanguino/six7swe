/**
 * Guards the database side of the identity contract.
 *
 * The policy in `domain/jobHunt/identity.ts` is tested against an in-memory
 * store that behaves the way the SQL is supposed to behave. These tests
 * check that the SQL really behaves that way, because the `auth_id IS NULL`
 * guard is the only thing standing between two subjects and the same row.
 */

jest.mock('../../db/index', () => ({ db: {} }));

import { drizzle } from 'drizzle-orm/pg-proxy';
import { unclaimedForEmail, unclaimedOnly } from '../../db/api/user';
import { users } from '../../db/schema/jobHunt';
import * as schema from '../../db/schema';

/**
 * Drizzle's proxy driver uses the same PgDialect as the real driver, so the
 * SQL renders identically, but it never opens a connection. It also avoids
 * importing `postgres` (ESM-only since v4), which Jest cannot `require()`.
 */
const db = drizzle(async () => ({ rows: [] }), { schema });

describe('the identity guards', () => {
  it('only finds a row that nobody owns for an email', () => {
    const query = db.select().from(users).where(unclaimedForEmail('a@example.com')).toSQL();

    expect(query.sql).toContain('"email" =');
    expect(query.sql).toContain('"auth_id" is null');
  });

  it('only claims a row that nobody owns', () => {
    const query = db.update(users).set({ authId: 'auth-1' }).where(unclaimedOnly(1)).toSQL();

    expect(query.sql).toContain('"id" =');
    expect(query.sql).toContain('"auth_id" is null');
  });
});

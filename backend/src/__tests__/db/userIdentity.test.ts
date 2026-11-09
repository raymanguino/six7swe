/**
 * Guards the database side of the identity contract.
 *
 * The policy in `domain/jobHunt/identity.ts` is tested against an in-memory
 * store that behaves the way the SQL is supposed to behave. These tests
 * check that the SQL really behaves that way, because the `auth_id IS NULL`
 * guard is the only thing standing between two subjects and the same row.
 */

jest.mock('../../db/index', () => ({ db: {} }));

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { unclaimedForEmail, unclaimedOnly } from '../../db/api/user';
import { users } from '../../db/schema/jobHunt';
import * as schema from '../../db/schema';

/**
 * A client that is never used to run a query, so nothing connects. It only
 * renders the SQL the builders produce.
 */
const client = postgres('postgres://user:pass@localhost:5432/db', { max: 1 });
const db = drizzle(client, { schema });

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

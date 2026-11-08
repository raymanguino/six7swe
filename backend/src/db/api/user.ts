import { eq, and, asc, isNull, type SQL } from 'drizzle-orm';
import { db } from '../index';
import { users, type User } from '../schema/jobHunt';
import { resolveIdentity, type IdentityStore } from '../../domain/jobHunt';

/** Postgres error code for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * True when the error is a unique constraint violation.
 *
 * The insert races are resolved by the database, so this is how the service
 * learns that another request won.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === UNIQUE_VIOLATION;
}

export interface UserService {
  getAllUsers(): Promise<User[]>;
  getUserById(id: number): Promise<User>;
  getUserByEmail(email: string): Promise<User>;
  getUserByAuthId(authId: string): Promise<User | null>;
  findOrCreateUserByAuthId(input: {
    authId: string;
    email: string | null;
    name?: string;
  }): Promise<User>;
}

export async function getAllUsers(): Promise<User[]> {
  return await db.select().from(users).orderBy(asc(users.id));
}

export async function getUserById(id: number): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user) {
    throw new Error('User not found');
  }
  return user;
}

export async function getUserByEmail(email: string): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    throw new Error('User not found');
  }
  return user;
}

export async function getUserByAuthId(authId: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.authId, authId));
  return user ?? null;
}

/**
 * The predicate that finds a row waiting to be claimed for this email.
 *
 * The `auth_id IS NULL` half is the guard: without it the lookup would
 * also match rows that already belong to someone, and those must never be
 * handed to a different subject.
 */
export function unclaimedForEmail(email: string): SQL | undefined {
  return and(eq(users.email, email), isNull(users.authId));
}

/**
 * The predicate that keeps a row from being claimed twice.
 *
 * The claim is an update, so it needs a guard that is evaluated by the
 * database: two subjects can both find the same unclaimed row, but only the
 * one whose update matches the row while it is still unowned will win.
 *
 * Exported so a test can assert the guard is really there. Dropping
 * `auth_id IS NULL` would let the second subject overwrite the first one's
 * link, which is the takeover this whole arrangement exists to prevent.
 */
export function unclaimedOnly(id: number): SQL | undefined {
  return and(eq(users.id, id), isNull(users.authId));
}

/**
 * The data operations behind the identity policy.
 *
 * The policy itself lives in `domain/jobHunt/identity.ts`; this is only the
 * part that knows about SQL.
 */
const identityStore: IdentityStore<User> = {
  async findByAuthId(authId) {
    const [row] = await db.select().from(users).where(eq(users.authId, authId));
    return row ?? null;
  },

  async findUnclaimedByEmail(email) {
    const [row] = await db.select().from(users).where(unclaimedForEmail(email)).limit(1);
    return row ?? null;
  },

  async claimUnclaimed(id, authId) {
    const [updated] = await db
      .update(users)
      .set({ authId, updatedAt: new Date() })
      .where(unclaimedOnly(id))
      .returning();
    return updated ?? null;
  },

  async insert(values) {
    try {
      const [created] = await db.insert(users).values(values).returning();
      return created ?? null;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null;
      }
      throw error;
    }
  },
};

/**
 * Returns the local user row for an authenticated identity, creating it on
 * first sign-in.
 *
 * `users.id` stays a serial because `profiles.user_id` references it; the
 * provider id is stored separately so the two never have to agree.
 */
export async function findOrCreateUserByAuthId(input: {
  authId: string;
  email: string | null;
  name?: string;
}): Promise<User> {
  return await resolveIdentity(identityStore, input);
}

import { eq, asc } from 'drizzle-orm';
import { db } from '../index';
import { users, type User } from '../schema/jobHunt';

export interface UserService {
  getAllUsers(): Promise<User[]>;
  getUserById(id: number): Promise<User>;
  getUserByEmail(email: string): Promise<User>;
  getUserByAuthId(authId: string): Promise<User | null>;
  findOrCreateUserByAuthId(input: {
    authId: string;
    email: string;
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
 * Returns the local user row for an authenticated identity, creating it on
 * first sign-in.
 *
 * `users.id` stays a serial because `profiles.user_id` references it; the
 * provider id is stored separately so the two never have to agree.
 */
export async function findOrCreateUserByAuthId(input: {
  authId: string;
  email: string;
  name?: string;
}): Promise<User> {
  const existing = await getUserByAuthId(input.authId);
  if (existing) {
    return existing;
  }

  // A row may already exist for the same email from a previous auth method.
  const byEmail = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
  const emailMatch = byEmail[0];

  if (emailMatch) {
    const [updated] = await db
      .update(users)
      .set({ authId: input.authId, updatedAt: new Date() })
      .where(eq(users.id, emailMatch.id))
      .returning();
    return updated ?? emailMatch;
  }

  const name = input.name?.trim() || input.email.split('@')[0] || 'User';

  const [created] = await db
    .insert(users)
    .values({ name, email: input.email, authId: input.authId })
    .returning();

  if (!created) {
    throw new Error('Failed to create user');
  }

  return created;
}

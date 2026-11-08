import { eq, and, asc, sql } from 'drizzle-orm';
import { db } from '../index';
import { profiles, type Profile } from '../schema/jobHunt';

export interface ProfileService {
  getAllProfiles(): Promise<Profile[]>;
  getProfileById(id: number): Promise<Profile | null>;
  getProfileByName(name: string): Promise<Profile | null>;
  getProfilesForUser(userId: number): Promise<Profile[]>;
  getProfileForUser(id: number, userId: number): Promise<Profile | null>;
  createProfile(input: CreateProfileInput): Promise<Profile>;
  updateProfile(id: number, userId: number, input: UpdateProfileInput): Promise<Profile | null>;
  deleteProfile(id: number, userId: number): Promise<boolean>;
}

export interface CreateProfileInput {
  userId: number;
  name: string;
  keywords?: string[];
  location?: string | null;
  additionalContext?: string | null;
  resume?: string | null;
}

export interface UpdateProfileInput {
  name?: string;
  keywords?: string[];
  location?: string | null;
  additionalContext?: string | null;
  resume?: string | null;
}

export async function getAllProfiles(): Promise<Profile[]> {
  return await db.select().from(profiles).orderBy(asc(profiles.id));
}

export async function getProfileById(id: number): Promise<Profile | null> {
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, id));
  return profile ?? null;
}

export async function getProfileByName(name: string): Promise<Profile | null> {
  const [profile] = await db.select().from(profiles).where(eq(profiles.name, name));
  return profile ?? null;
}

/** Profiles belonging to a specific user. */
export async function getProfilesForUser(userId: number): Promise<Profile[]> {
  return await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .orderBy(asc(profiles.id));
}

/**
 * A profile owned by the given user.
 *
 * Every read of another user's profile goes through this, so a caller cannot
 * reach a profile by guessing its id.
 */
export async function getProfileForUser(
  id: number,
  userId: number,
): Promise<Profile | null> {
  const [profile] = await db
    .select()
    .from(profiles)
    .where(and(eq(profiles.id, id), eq(profiles.userId, userId)));
  return profile ?? null;
}

export async function createProfile(input: CreateProfileInput): Promise<Profile> {
  const [profile] = await db
    .insert(profiles)
    .values({
      userId: input.userId,
      name: input.name,
      keywords: input.keywords ?? [],
      location: input.location ?? null,
      additionalContext: input.additionalContext ?? null,
      resume: input.resume ?? null,
    })
    .returning();

  if (!profile) {
    throw new Error('Failed to create profile');
  }
  return profile;
}

export async function updateProfile(
  id: number,
  userId: number,
  input: UpdateProfileInput,
): Promise<Profile | null> {
  const updates: Partial<typeof profiles.$inferInsert> = { updatedAt: new Date() };

  if (input.name !== undefined) updates.name = input.name;
  if (input.keywords !== undefined) updates.keywords = input.keywords;
  if (input.location !== undefined) updates.location = input.location;
  if (input.additionalContext !== undefined) {
    updates.additionalContext = input.additionalContext;
  }
  if (input.resume !== undefined) updates.resume = input.resume;

  const [profile] = await db
    .update(profiles)
    .set(updates)
    .where(and(eq(profiles.id, id), eq(profiles.userId, userId)))
    .returning();

  return profile ?? null;
}

export async function deleteProfile(id: number, userId: number): Promise<boolean> {
  const rows = await db
    .delete(profiles)
    .where(and(eq(profiles.id, id), eq(profiles.userId, userId)))
    .returning({ id: profiles.id });

  return rows.length > 0;
}

/** True when the profile belongs to the user. */
export async function profileBelongsToUser(id: number, userId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.id, id), eq(profiles.userId, userId)))
    .limit(1);
  return Boolean(row);
}

/** Counts the profiles owned by a user. Used by tests and diagnostics. */
export async function countProfilesForUser(userId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  return row?.count ?? 0;
}

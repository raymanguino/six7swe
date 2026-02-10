import { eq, asc } from 'drizzle-orm';
import { db } from '../index';
import { profiles, type Profile } from '../schema';

export interface ProfileService {
  getAllProfiles(): Promise<Profile[]>;
  getProfileById(id: number): Promise<Profile | null>;
  getProfileByName(name: string): Promise<Profile | null>;
}

export async function getAllProfiles(): Promise<Profile[]> {
  return await db.select().from(profiles).orderBy(asc(profiles.id));
}

export async function getProfileById(id: number): Promise<Profile | null> {
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, id));
  return profile ?? null;
}

export async function getProfileByName(name: string): Promise<Profile | null> {
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.name, name));
  return profile ?? null;
}

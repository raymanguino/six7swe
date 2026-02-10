import { eq, asc, sql } from 'drizzle-orm';
import { db } from '../index';
import { profileJobs, profiles, type ProfileJob } from '../schema';

export interface ProfileJobService {
  getProfileJobs(profileId: number): Promise<ProfileJob[]>;
  getProfileJobById(profileJobId: number): Promise<ProfileJob | null>;
  bulkInsertProfileJobs(items: InsertProfileJobInput[]): Promise<ProfileJob[]>;
  getJobsForProfile(profileId: number): Promise<ProfileJob[]>;
}

export interface InsertProfileJobInput {
  profile_id: number;
  job_id: number;
  job_hash: string;
  score?: string | null;
  explanation?: string | null;
  first_skill_match?: string | null;
  second_skill_match?: string | null;
  third_skill_match?: string | null;
  summary?: string | null;
}

export async function getProfileJobs(profileId: number): Promise<ProfileJob[]> {
  return await db
    .select()
    .from(profileJobs)
    .where(eq(profileJobs.profileId, profileId))
    .orderBy(asc(profileJobs.id));
}

export async function getProfileJobById(
  profileJobId: number
): Promise<ProfileJob | null> {
  const [pj] = await db
    .select()
    .from(profileJobs)
    .where(eq(profileJobs.id, profileJobId));
  return pj ?? null;
}

export async function bulkInsertProfileJobs(
  items: InsertProfileJobInput[]
): Promise<ProfileJob[]> {
  if (items.length === 0) {
    return [];
  }

  const values = items.map((item) => ({
    profileId: item.profile_id,
    jobId: item.job_id,
    jobHash: item.job_hash,
    score: (item.score?.toUpperCase() ?? null) as
      | 'LOW'
      | 'MEDIUM'
      | 'HIGH'
      | 'TOP'
      | null,
    explanation: item.explanation ?? null,
    firstSkillMatch: item.first_skill_match ?? null,
    secondSkillMatch: item.second_skill_match ?? null,
    thirdSkillMatch: item.third_skill_match ?? null,
    summary: item.summary ?? null,
  }));

  return await db
    .insert(profileJobs)
    .values(values)
    .onConflictDoUpdate({
      target: [profileJobs.profileId, profileJobs.jobId],
      set: {
        jobHash: sql`excluded.job_hash`,
        score: sql`excluded.score`,
        explanation: sql`excluded.explanation`,
        firstSkillMatch: sql`excluded.first_skill_match`,
        secondSkillMatch: sql`excluded.second_skill_match`,
        thirdSkillMatch: sql`excluded.third_skill_match`,
        summary: sql`excluded.summary`,
        updatedAt: new Date(),
      },
    })
    .returning();
}

export async function getJobsForProfile(
  profileId: number
): Promise<ProfileJob[]> {
  return await db
    .select({
      id: profileJobs.id,
      profileId: profileJobs.profileId,
      jobId: profileJobs.jobId,
      jobHash: profileJobs.jobHash,
      score: profileJobs.score,
      explanation: profileJobs.explanation,
      firstSkillMatch: profileJobs.firstSkillMatch,
      secondSkillMatch: profileJobs.secondSkillMatch,
      thirdSkillMatch: profileJobs.thirdSkillMatch,
      summary: profileJobs.summary,
      createdAt: profileJobs.createdAt,
      updatedAt: profileJobs.updatedAt,
    })
    .from(profileJobs)
    .innerJoin(profiles, eq(profileJobs.profileId, profiles.id))
    .where(eq(profiles.id, profileId))
    .orderBy(asc(profileJobs.id));
}

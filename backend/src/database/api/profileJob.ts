import { Client } from 'pg';
import { ProfileJob } from '../../types';

export interface ProfileJobService {
  getProfileJobs(client: Client, profileId: number): Promise<ProfileJob>;
  getProfileJobById(client: Client, profileJobId: number): Promise<ProfileJob>;
  bulkInsertProfileJobs(client: Client, jobs: Array<ProfileJob>): Promise<ProfileJob[]>;
  getJobsForProfile(client: Client, profileId: number): Promise<ProfileJob[]>;
}

export async function getProfileJobs(
  client: Client,
  profileId: number
): Promise<ProfileJob[]> {
  const { rows } = await client.query(`
    SELECT * 
    FROM profile_jobs
    WHERE profile_id = $1
    ORDER BY id
  `, [profileId]);

  return rows;
}

export async function getProfileJobById(
  client: Client,
  profileJobId: number
): Promise<ProfileJob | null> {
  const { rows } = await client.query(`
    SELECT * 
    FROM profile_jobs
    WHERE id = $1
  `, [profileJobId]);

  if (rows.length === 0) {
    return null;
  }

  return rows[0];
}

export async function bulkInsertProfileJobs(
  client: Client,
  jobs: Array<ProfileJob>
): Promise<Array<ProfileJob>> {
  if (jobs.length === 0) {
    return [];
  }

  // Create placeholders for each row: ($1,$2,$3,$4,$5,$6,$7,$8,$9), ($10,$11,$12,$13,$14,$15,$16,$17,$18), etc.
  const placeholders = jobs.map((_, index) => {
    const offset = index * 9; // 9 columns per row
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`;
  }).join(', ');

  const values = jobs.map(job => [
    job.profile_id,
    job.job_id,
    job.job_hash,
    job.score,
    job.explanation,
    job.first_skill_match,
    job.second_skill_match,
    job.third_skill_match,
    job.summary,
  ]).flat();

  const { rows } = await client.query(`
    INSERT INTO profile_jobs (profile_id, job_id, job_hash, score, explanation, first_skill_match, second_skill_match, third_skill_match, summary)
    VALUES ${placeholders}
    ON CONFLICT (profile_id, job_id) DO UPDATE
    SET job_hash = EXCLUDED.job_hash,
        score = EXCLUDED.score,
        explanation = EXCLUDED.explanation,
        first_skill_match = EXCLUDED.first_skill_match,
        second_skill_match = EXCLUDED.second_skill_match,
        third_skill_match = EXCLUDED.third_skill_match,
        summary = EXCLUDED.summary,
        updated_at = NOW()
    RETURNING *
  `, values);

  return rows;
}

export async function getJobsForProfile(
  client: Client,
  profileId: number
): Promise<ProfileJob[]> {
  const { rows } = await client.query(`
    SELECT pj.* 
    FROM profile_jobs pj
    JOIN profiles p ON pj.profile_id = p.id
    WHERE p.id = $1
    ORDER BY pj.id
  `, [profileId]);

  return rows;
}

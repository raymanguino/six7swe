import { Client } from 'pg';
import { Job } from '../../types';
import { hashData } from '../../util';

export interface JobService {
  getAllJobs(client: Client, filter?: JobFilter): Promise<Job[]>;
  getJobById(client: Client, id: number): Promise<Job | null>;
  getJobBySourceId(client: Client, sourceId: string, sourceJobId: string): Promise<Job | null>;
  bulkInsertJobs(client: Client, jobs: Array<Job>): Promise<Array<Job>>;
}

export interface JobFilter {
  source: string | null;
}

export async function getAllJobs(
  client: Client,
  filter: JobFilter = {
    source: 'LINKEDIN' 
  }
): Promise<Job[]> {
  const { rows } = await client.query(`
    SELECT * 
    FROM jobs 
    WHERE source_id = $1 
    ORDER BY id
  `, [filter.source]);

  return rows
}

export async function getJobBySourceId(
  client: Client,
  sourceId: string,
  sourceJobId: string
): Promise<Job | null> {
  const { rows } = await client.query(`
    SELECT * 
    FROM jobs 
    WHERE source_id = $1 AND source_job_id = $2
  `, [sourceId, sourceJobId]);

  return rows[0];
}

export async function getJobById(
  client: Client,
  id: number
): Promise<Job | null> {
  const { rows } = await client.query(`
    SELECT * 
    FROM jobs 
    WHERE id = $1
  `, [id]);

  if (rows.length === 0) {
    return null;
  }

  return rows[0];
}

export async function bulkInsertJobs(
  client: Client,
  jobs: Array<Job>
): Promise<Array<Job>> {
  if (jobs.length === 0) {
    return [];
  }

  // Create placeholders for each row: ($1,$2,$3,$4,$5,$6,$7), ($8,$9,$10,$11,$12,$13,$14), etc.
  const placeholders = jobs.map((_, index) => {
    const offset = index * 7; // 7 columns per row
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`;
  }).join(', ');

  const values = jobs.map(job => [
    job.source_id,
    job.source_job_id,
    job.link,
    job.company,
    job.title,
    job.description,
    hashJob(job)
  ]).flat();

  const { rows } = await client.query(`
    INSERT INTO jobs (source_id, source_job_id, link, company, position, description, hash)
    VALUES ${placeholders}
    ON CONFLICT (source_id,source_job_id) DO UPDATE
    SET link = EXCLUDED.link,
        company = EXCLUDED.company,
        position = EXCLUDED.position,
        description = EXCLUDED.description,
        hash = EXCLUDED.hash,
        updated_at = NOW()
    RETURNING *`, values);
  return rows;
}

function hashJob(job: Job): string {
  return hashData(`${job.location}|${job.company}|${job.title}|${job.description}`);
}

export default {
  getAllJobs,
  getJobById,
  bulkInsertJobs
};

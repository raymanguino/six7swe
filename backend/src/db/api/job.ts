import { eq, and, sql, asc } from 'drizzle-orm';
import { db } from '../index';
import { jobs, type Job } from '../schema';
import { hashData } from '../../util';

export interface JobService {
  getAllJobs(filter?: JobFilter): Promise<Job[]>;
  getJobById(id: number): Promise<Job | null>;
  getJobBySourceId(sourceId: string, sourceJobId: string): Promise<Job | null>;
  bulkInsertJobs(items: JobInput[]): Promise<Job[]>;
}

export interface JobFilter {
  source: string | null;
}

/** Input for bulk insert: accepts scraper output with `title` (mapped to `position`) */
export interface JobInput {
  source_id?: string;
  source_job_id: string;
  link: string;
  company: string;
  title?: string;
  position?: string;
  description: string;
  location?: string;
  [key: string]: unknown;
}

export async function getAllJobs(
  filter: JobFilter = { source: 'LINKEDIN' }
): Promise<Job[]> {
  return await db
    .select()
    .from(jobs)
    .where(eq(jobs.sourceId, filter.source as 'LINKEDIN'))
    .orderBy(asc(jobs.id));
}

export async function getJobBySourceId(
  sourceId: string,
  sourceJobId: string
): Promise<Job | null> {
  const [job] = await db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.sourceId, sourceId as 'LINKEDIN'), eq(jobs.sourceJobId, sourceJobId))
    );
  return job ?? null;
}

export async function getJobById(id: number): Promise<Job | null> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  return job ?? null;
}

export async function bulkInsertJobs(items: JobInput[]): Promise<Job[]> {
  if (items.length === 0) {
    return [];
  }

  const values = items.map((job) => {
    const sourceId = (job.source_id ?? 'LINKEDIN').toString().toUpperCase() as
      | 'LINKEDIN'
      | 'INDEED'
      | 'GLASSDOOR'
      | 'COMPANY_WEBSITE'
      | 'OTHER';
    const position = job.position ?? job.title ?? '';
    const hash = hashJob(job);
    return {
      sourceId,
      sourceJobId: job.source_job_id,
      link: job.link,
      company: job.company,
      position,
      description: job.description,
      hash,
    };
  });

  const results = await db
    .insert(jobs)
    .values(values)
    .onConflictDoUpdate({
      target: [jobs.sourceId, jobs.sourceJobId],
      set: {
        link: sql`excluded.link`,
        company: sql`excluded.company`,
        position: sql`excluded.position`,
        description: sql`excluded.description`,
        hash: sql`excluded.hash`,
        updatedAt: new Date(),
      },
    })
    .returning();

  return results;
}

function hashJob(job: JobInput): string {
  const position = job.position ?? job.title ?? '';
  return hashData(`${job.company}|${position}|${job.description}`);
}

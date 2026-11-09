import { eq, and, sql, asc, isNull } from 'drizzle-orm';
import { db } from '../index';
import { jobs, type Job, type JobSource } from '../schema/jobHunt';
import { hashData } from '../../util';

export interface JobService {
  getAllJobs(filter?: JobFilter): Promise<Job[]>;
  getJobById(id: number): Promise<Job | null>;
  getJobBySourceId(sourceId: JobSource, sourceJobId: string): Promise<Job | null>;
  bulkInsertJobs(items: JobInput[]): Promise<Job[]>;
}

export interface JobFilter {
  source: JobSource | null;
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
  datePosted?: string;
}

export async function getAllJobs(
  filter: JobFilter = { source: 'LINKEDIN' }
): Promise<Job[]> {
  const sourceFilter =
    filter.source === null
      ? isNull(jobs.sourceId)
      : eq(jobs.sourceId, filter.source);

  return await db
    .select()
    .from(jobs)
    .where(sourceFilter)
    .orderBy(asc(jobs.id));
}

export async function getJobBySourceId(
  sourceId: JobSource,
  sourceJobId: string
): Promise<Job | null> {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.sourceId, sourceId), eq(jobs.sourceJobId, sourceJobId)));
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
    const sourceId = normalizeSourceId(job.source_id);
    const position = job.position ?? job.title ?? '';
    const hash = hashJob(job);
    return {
      sourceId,
      sourceJobId: job.source_job_id,
      link: job.link,
      company: job.company,
      position,
      description: job.description,
      location: job.location ?? null,
      datePosted: job.datePosted ?? null,
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
        location: sql`excluded.location`,
        datePosted: sql`excluded.date_posted`,
        hash: sql`excluded.hash`,
        updatedAt: new Date(),
      },
    })
    .returning();

  return results;
}

const JOB_SOURCE_IDS: readonly JobSource[] = [
  'LINKEDIN',
  'INDEED',
  'GLASSDOOR',
  'COMPANY_WEBSITE',
  'OTHER',
];

/** Maps a scraper source name onto the stored enum, defaulting to LINKEDIN. */
export function normalizeSourceId(sourceId: string | undefined): JobSource {
  const normalized = (sourceId ?? 'LINKEDIN').trim().toUpperCase();
  const match = JOB_SOURCE_IDS.find((candidate) => candidate === normalized);
  return match ?? 'OTHER';
}

/**
 * Content fingerprint of a posting.
 *
 * Includes the fields that decide whether a posting is still the same job,
 * so a change in any of them re-triggers a match score.
 */
function hashJob(job: JobInput): string {
  const position = job.position ?? job.title ?? '';
  return hashData(
    [
      job.company,
      position,
      job.location ?? '',
      job.description,
    ].join('|'),
  );
}

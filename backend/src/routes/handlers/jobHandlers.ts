import { FastifyRequest, FastifyReply } from 'fastify';
import type { JobSource } from '../../db/schema/jobHunt';

const SOURCE_ALIASES: Record<string, JobSource> = {
  linkedin: 'LINKEDIN',
  li: 'LINKEDIN',
  indeed: 'INDEED',
  glassdoor: 'GLASSDOOR',
  company_website: 'COMPANY_WEBSITE',
  other: 'OTHER',
};

/** Maps a source name or alias onto the stored enum value. */
export function normalizeSourceId(sourceId: string): JobSource | null {
  return SOURCE_ALIASES[sourceId.trim().toLowerCase()] ?? null;
}

export async function getAllJobs(request: FastifyRequest, reply: FastifyReply) {
  try {
    const jobs = await request.server.jobService.getAllJobs();
    return reply.code(200).send({ jobs });
  } catch (error) {
    request.log.error({ err: error }, 'Error calling getAllJobs()');
    return reply.code(500).send({ error: 'Failed to fetch jobs' });
  }
}

export async function getJobBySourceId(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { source_id, source_job_id } = request.params as {
      source_id: string;
      source_job_id: string;
    };

    if (!source_id || !source_job_id) {
      return reply.code(400).send({
        error: 'Invalid or missing source_id or source_job_id',
      });
    }

    const sourceId = normalizeSourceId(source_id);
    if (!sourceId) {
      return reply.code(400).send({ error: 'Unsupported source_id' });
    }

    const job = await request.server.jobService.getJobBySourceId(sourceId, source_job_id);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found' });
    }

    return reply.code(200).send({ job });
  } catch (error) {
    request.log.error({ err: error }, 'Error calling getJobBySourceId()');
    return reply.code(500).send({ error: 'Failed to fetch job' });
  }
}

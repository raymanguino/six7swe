import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import type { Job, ProfileJob, RefreshStatus } from '../../types';
import type { JobInput } from '../../db/api/job';
import { JobMatchEvaluation } from '../../services/agents';
import { SixSevenService } from '../service';

export async function runRefreshJobsForProfile(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const server = request.server as FastifyInstance & SixSevenService;

  try {
    const { profileId } = request.params as { profileId: string };
    const profileIdNum = parseInt(profileId);

    const refreshStatus =
      await server.refreshStatusService.newProfileRefreshStatus(profileIdNum);

    const profile =
      await server.profileService.getProfileById(profileIdNum);
    if (!profile) {
      throw new Error('Profile id not found: ' + profileIdNum);
    }

    const keywords = profile.keywords ?? [];
    const location = profile.location ?? '';

    server.jobFetchService.runJobFetch(
      keywords,
      location,
      async (fetchedJobs: Array<JobInput & { source_id?: string }>) => {
        const jobInputs = fetchedJobs.map((job) => ({
          ...job,
          source_id: (job.source_id ?? 'LINKEDIN').toUpperCase(),
        }));
        const savedJobs = await server.jobService.bulkInsertJobs(jobInputs);

        const savedProfileJobs =
          await server.profileJobService.getProfileJobs(profileIdNum);

        const jobsToFilter = new Set(savedProfileJobs.map((pj) => pj.jobId));
        const newJobs = savedJobs.filter((job) => !jobsToFilter.has(job.id));

        const newProfileJobs: Array<{
          profile_id: number;
          job_id: number;
          job_hash: string;
          score: string;
          explanation: string;
          first_skill_match: string;
          second_skill_match: string;
          third_skill_match: string;
          summary: string;
        }> = await Promise.all(
          newJobs.map(async (job) => {
            const evaluation =
              await server.agentServices.evaluateJobMatch(profile, job);
            const result: JobMatchEvaluation = evaluation.finalOutput;

            return {
              profile_id: profileIdNum,
              job_id: job.id,
              job_hash: job.hash,
              score: result.score.toUpperCase(),
              explanation: result.explanation,
              first_skill_match: result.first_skill_match,
              second_skill_match: result.second_skill_match,
              third_skill_match: result.third_skill_match,
              summary: result.summary,
            };
          })
        );

        await server.profileJobService.bulkInsertProfileJobs(newProfileJobs);

        await server.refreshStatusService.updateRefreshStatus(refreshStatus.id, {
          description: `Fetched and saved ${savedJobs.length} jobs for profile ${profileIdNum}.`,
        });
      },
      (description: string) =>
        server.refreshStatusService.updateRefreshStatus(refreshStatus.id, {
          description,
        }),
      (summary: string) =>
        server.refreshStatusService.endSuccess(refreshStatus.id, summary),
      (error: string) =>
        server.refreshStatusService.endFailure(refreshStatus.id, error)
    );

    await server.refreshStatusService.updateRefreshStatus(refreshStatus.id, {
      status: 'IN_PROGRESS',
      step: 'FETCHING_JOBS',
      description: 'Started job fetch.',
    });

    reply.code(200).send({ refreshStatusId: refreshStatus.id });
  } catch (error) {
    server.log.error(error, 'Error running job fetch:');
    reply.code(500).send({ error: 'Failed to run job fetch.' });
  }
}

export async function getRefreshStatus(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const server = request.server as FastifyInstance & SixSevenService;

  try {
    const { refreshId } = request.params as { profileId: string; refreshId: string };

    const refreshStatus: RefreshStatus | null =
      await server.refreshStatusService.getRefreshStatus(parseInt(refreshId));

    if (!refreshStatus) {
      reply.code(404);
      return { error: 'Refresh status not found' };
    }

    return reply.code(200).send({ refreshStatus });
  } catch (error) {
    server.log.error(error, 'Error fetching refresh status:');
    reply.code(500).send({ error: 'Failed to fetch refresh status.' });
  }
}

export async function getJobsForProfile(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const server = request.server as FastifyInstance & SixSevenService;

  try {
    const { profileId } = request.params as { profileId: string };

    const jobs: ProfileJob[] =
      await server.profileJobService.getJobsForProfile(parseInt(profileId));

    return reply.code(200).send({ jobs });
  } catch (error) {
    server.log.error(error, 'Error fetching jobs for profile:');
    reply.code(500).send({ error: 'Failed to fetch jobs for profile.' });
  }
}

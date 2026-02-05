import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { PoolClient } from 'pg';
import { Job, ProfileJob, RefreshStatus } from '../../types';
import { withClient } from '../../util';
import { JobMatchEvaluation } from '../../services/agents';
import { SixSevenService } from '../service';

export async function runRefreshJobsForProfile(request: FastifyRequest, reply: FastifyReply) {
  const server = request.server as FastifyInstance & SixSevenService;
  let client: PoolClient | null = null;

  try {
    let { profileId } = request.params as { profileId: number };

    client = await server.pg.connect();

    const refreshStatus = await server.refreshStatusService.newProfileRefreshStatus(client, profileId);

    const profile = await server.profileService.getProfileById(client, profileId);
    if (!profile) {
      throw new Error('Profile id not found: ' + profileId);
    }

    // Start the job fetch in the background
    server.jobFetchService.runJobFetch(
      profile.keywords, 
      profile.location, 
      (fetchedJobs: Array<Job>) => withClient(async (pgClient) => {
        const savedJobs: Array<Job> = await server.jobService.bulkInsertJobs(pgClient, fetchedJobs.map(job => ({
          ...job,
          source_id: job.source_id.toUpperCase(),
        }) as Job));

        const savedProfileJobs: Array<ProfileJob> = await server.profileJobService.getProfileJobs(pgClient, profileId);

        // Filter out jobs already associated with the profile
        const jobsToFilter = new Set(savedProfileJobs.map(pj => pj.id));
        const newJobs = savedJobs.filter(job => !jobsToFilter.has(job.id));

        const newProfileJobs: Array<ProfileJob> = await Promise.all(newJobs.map(async job => {
          const evaluation = await server.agentServices.evaluateJobMatch(profile, job);
          const result: JobMatchEvaluation = evaluation.finalOutput;

          return {
            profile_id: profileId,
            job_id: job.id,
            job_hash: job.hash,
            score: result.score.toUpperCase(),
            explanation: result.explanation,
            first_skill_match: result.first_skill_match,
            second_skill_match: result.second_skill_match,
            third_skill_match: result.third_skill_match,
            summary: result.summary,
          } as ProfileJob;
        }));

        await server.profileJobService.bulkInsertProfileJobs(pgClient, newProfileJobs);
        
        await server.refreshStatusService.updateRefreshStatus(pgClient, refreshStatus.id, { 
          description: `Fetched and saved ${savedJobs.length} jobs for profile ${profileId}.` 
        });
      })(),
      (description: string) => withClient(async (pgClient) => {
        await server.refreshStatusService.updateRefreshStatus(pgClient, refreshStatus.id, { description });
      })(),
      (summary: string) => withClient(async (pgClient) => {
        await server.refreshStatusService.endSuccess(pgClient, refreshStatus.id, summary);
      })(),
      (error: string) => withClient(async (pgClient) => {
        await server.refreshStatusService.endFailure(pgClient, refreshStatus.id, error);
      })(),
    );

    server.refreshStatusService.updateRefreshStatus(client, refreshStatus.id, { 
      status: 'IN_PROGRESS', step: 'FETCHING_JOBS', description: 'Started job fetch.' 
    });

    reply.code(200).send({ refreshStatusId: refreshStatus.id });
  } catch (error) {
    server.log.error(error, 'Error running job fetch:');
    reply.code(500).send({ error: 'Failed to run job fetch.' });
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function getRefreshStatus(request: FastifyRequest, reply: FastifyReply): Promise<any> {
  const server = request.server as FastifyInstance & SixSevenService;
  let client;

  try {
    client = await server.pg.connect();

    const { profileId, refreshId } = request.params as { profileId: string; refreshId: string };

    const refreshStatus: RefreshStatus | null = await server.refreshStatusService.getRefreshStatus(client, parseInt(refreshId));

    if (!refreshStatus) {
      reply.code(404);
      return { error: 'Refresh status not found' };
    }

    return { refreshStatus };
  } catch (error) {
    server.log.error(error, 'Error fetching refresh status:');
    reply.code(500).send({ error: 'Failed to fetch refresh status.' });
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function getJobsForProfile(request: FastifyRequest, reply: FastifyReply): Promise<any> {
  const server = request.server as FastifyInstance & SixSevenService;
  let client;

  try {
    client = await server.pg.connect();

    const { profileId } = request.params as { profileId: string };

    const jobs = await server.profileJobService.getJobsForProfile(client, parseInt(profileId));

    return { jobs };
  } catch (error) {
    server.log.error(error, 'Error fetching jobs for profile:');
    reply.code(500).send({ error: 'Failed to fetch jobs for profile.' });
  } finally {
    if (client) {
      client.release();
    }
  }
}

import Fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import fastifyRequestContext, { requestContext } from '@fastify/request-context';
import { UnauthenticatedUser } from '../../constants';
import { runRefreshJobsForProfile } from '../../routes/handlers/profileJobHandlers';
import { createJobRefreshService } from '../../services/jobHunt/jobRefreshService';

/**
 * `POST .../jobs/refresh` only queues the refresh for the scraper worker: it
 * answers with the row to poll and never runs the pipeline.
 */

const silent = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
} as unknown as FastifyBaseLogger;

async function post(active: { id: number } | null = null) {
  const refreshStatusService = {
    getActiveRefreshForProfile: jest.fn().mockResolvedValue(active),
    enqueueRefresh: jest.fn().mockResolvedValue({ id: 51 }),
    newProfileRefreshStatus: jest.fn(),
    updateRefreshStatus: jest.fn(),
    heartbeatRefresh: jest.fn(),
  };
  const app = Fastify();
  await app.register(fastifyRequestContext, { defaultStoreValues: { user: UnauthenticatedUser } });
  app.addHook('onRequest', async () => {
    requestContext.set('user', { id: 1, email: null, authId: 'owner' });
  });
  app.decorate('profileService', {
    profileBelongsToUser: jest.fn().mockResolvedValue(true),
  } as never);
  // Built as the API plugin builds it: with no job fetcher.
  app.decorate(
    'jobRefreshService',
    createJobRefreshService({
      jobService: {} as never,
      profileJobService: {} as never,
      profileService: {
        getProfileById: async () => ({ id: 1, keywords: [], location: '105149290' }),
      } as never,
      refreshStatusService: refreshStatusService as never,
      knowledge: { source: null, ownerAuthId: null },
      logger: silent,
      heartbeatMs: 5,
    }),
  );
  app.post('/job-hunt/profiles/:profileId/jobs/refresh', runRefreshJobsForProfile);
  const response = await app.inject({ method: 'POST', url: '/job-hunt/profiles/1/jobs/refresh' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await app.close();
  return { response, refreshStatusService };
}

describe('POST /job-hunt/profiles/:profileId/jobs/refresh', () => {
  it('queues the refresh and answers 202 with its id, without running it', async () => {
    const { response, refreshStatusService } = await post();

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ refreshStatusId: 51 });
    expect(refreshStatusService.enqueueRefresh).toHaveBeenCalledWith(1);
    expect(refreshStatusService.newProfileRefreshStatus).not.toHaveBeenCalled();
    expect(refreshStatusService.updateRefreshStatus).not.toHaveBeenCalled();
    expect(refreshStatusService.heartbeatRefresh).not.toHaveBeenCalled();
  });

  it('keeps answering 409 while the profile has a refresh queued or running', async () => {
    const { response, refreshStatusService } = await post({ id: 7 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'A refresh is already running for this profile.' });
    expect(refreshStatusService.enqueueRefresh).not.toHaveBeenCalled();
  });
});

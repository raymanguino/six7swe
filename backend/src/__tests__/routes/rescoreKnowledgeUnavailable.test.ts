import Fastify from 'fastify';
import fastifyRequestContext, { requestContext } from '@fastify/request-context';
import { UnauthenticatedUser } from '../../constants';
import { runRescoreForProfile } from '../../routes/handlers/profileJobHandlers';
import {
  KnowledgeNotConfiguredError,
  KnowledgeUnavailableError,
} from '../../services/jobHunt/jobRefreshService';

async function post(rescoreError: Error) {
  const app = Fastify();
  await app.register(fastifyRequestContext, {
    defaultStoreValues: { user: UnauthenticatedUser },
  });
  app.addHook('onRequest', async () => {
    requestContext.set('user', { id: 1, email: null, authId: 'owner' });
  });
  app.decorate('profileService', {
    profileBelongsToUser: jest.fn().mockResolvedValue(true),
  } as never);
  app.decorate('jobRefreshService', {
    rescore: jest.fn().mockRejectedValue(rescoreError),
  } as never);
  app.post('/job-hunt/profiles/:profileId/jobs/rescore', runRescoreForProfile);
  const response = await app.inject({ method: 'POST', url: '/job-hunt/profiles/1/jobs/rescore' });
  await app.close();
  return response;
}

describe('rescore when the knowledge service is down', () => {
  it('answers 503 with a retry message instead of a generic 500', async () => {
    const response = await post(
      new KnowledgeUnavailableError({ cause: new Error('ECONNREFUSED') }),
    );
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'The knowledge service is unavailable. Try again shortly.',
    });
  });

  it('keeps the not-configured 503 distinct', async () => {
    const response = await post(new KnowledgeNotConfiguredError());
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'The knowledge base is not available.' });
  });
});

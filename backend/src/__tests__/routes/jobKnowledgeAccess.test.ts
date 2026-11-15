import Fastify, { FastifyInstance } from 'fastify';
import fastifyRequestContext, { requestContext } from '@fastify/request-context';
import { UnauthenticatedUser } from '../../constants';
import {
  getJobsForProfile,
  getKnowledgeStatus,
  getRefreshStatus,
} from '../../routes/handlers/profileJobHandlers';
import type { JobKnowledgeSource } from '../../services/jobHunt/knowledgeSource';
import type { ProfileJobWithDetails } from '../../db/api/profileJob';

/**
 * The knowledge base is the owner's private background. Only the owner's
 * profiles see anything about it: every other user's match list and status
 * response carry no version, no staleness and no evidence.
 */

const OWNER_SUB = 'owner-sub';
const DOC_ID = '11111111-1111-4111-8111-111111111111';

const match: ProfileJobWithDetails = {
  id: 10,
  profileId: 1,
  jobId: 1,
  jobHash: 'h1',
  score: 80,
  band: 'TOP',
  explanation: null,
  firstSkillMatch: null,
  secondSkillMatch: null,
  thirdSkillMatch: null,
  summary: null,
  // Scored while the knowledge base was in use, at an older version.
  knowledgeVersion: 3,
  evidence: [{ documentId: DOC_ID, filename: 'resume.pdf' }],
  createdAt: new Date(),
  updatedAt: new Date(),
  job: {
    id: 1,
    sourceId: 'LINKEDIN',
    sourceJobId: 'src-1',
    link: 'https://example.com/jobs/1',
    company: 'Acme',
    position: 'Engineer',
    location: null,
    datePosted: null,
  },
};

function makeSource(): jest.Mocked<JobKnowledgeSource> {
  return {
    getVersion: jest.fn().mockResolvedValue(5),
    retrieve: jest.fn(),
    getProfileSummary: jest.fn(),
    getSummary: jest.fn().mockResolvedValue({ documentCount: 4, updatedAt: null }),
  };
}

async function buildApp(options: { userAuthId: string; source: JobKnowledgeSource }) {
  const app = Fastify();
  await app.register(fastifyRequestContext, {
    defaultStoreValues: { user: UnauthenticatedUser },
  });
  app.addHook('onRequest', async () => {
    requestContext.set('user', { id: 1, email: null, authId: options.userAuthId });
  });
  const getRefreshStatusRow = jest.fn().mockResolvedValue({ id: 7, profileId: 1 });
  app.decorate('profileService', {
    profileBelongsToUser: jest.fn().mockResolvedValue(true),
    // The profile belongs to the requesting user.
    getProfileOwnerAuthId: jest.fn().mockResolvedValue(options.userAuthId),
  } as never);
  app.decorate('profileJobService', {
    getJobsForProfile: jest.fn().mockResolvedValue([match]),
  } as never);
  app.decorate('refreshStatusService', { getRefreshStatus: getRefreshStatusRow } as never);
  app.decorate('jobKnowledge', { source: options.source, ownerAuthId: OWNER_SUB });

  app.get('/job-hunt/profiles/:profileId/jobs', getJobsForProfile);
  app.get('/job-hunt/profiles/:profileId/jobs/refresh/:refreshId', getRefreshStatus);
  app.get('/job-hunt/knowledge', getKnowledgeStatus);
  return { app, getRefreshStatusRow };
}

describe('job knowledge access', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('gives a non-owner no knowledge details in the match list', async () => {
    const source = makeSource();
    ({ app } = await buildApp({ userAuthId: 'someone-else', source }));

    const response = await app.inject({ method: 'GET', url: '/job-hunt/profiles/1/jobs' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.knowledge).toEqual({ configured: false });
    expect(body.jobs[0]).toMatchObject({ knowledgeVersion: null, evidence: [], stale: false });
    expect(response.body).not.toContain(DOC_ID);
    expect(response.body).not.toContain('resume.pdf');
    expect(source.getVersion).not.toHaveBeenCalled();
  });

  it('gives a non-owner only { configured: false } for the knowledge status', async () => {
    const source = makeSource();
    ({ app } = await buildApp({ userAuthId: 'someone-else', source }));

    const response = await app.inject({ method: 'GET', url: '/job-hunt/knowledge' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: false });
    expect(source.getSummary).not.toHaveBeenCalled();
  });

  it('gives the owner staleness and evidence', async () => {
    ({ app } = await buildApp({ userAuthId: OWNER_SUB, source: makeSource() }));

    const list = await app.inject({ method: 'GET', url: '/job-hunt/profiles/1/jobs' });
    expect(list.json().knowledge).toEqual({ configured: true, version: 5, staleCount: 1 });
    expect(list.json().jobs[0]).toMatchObject({
      stale: true,
      evidence: [{ documentId: DOC_ID, filename: 'resume.pdf' }],
    });

    const status = await app.inject({ method: 'GET', url: '/job-hunt/knowledge' });
    expect(status.json()).toEqual({
      configured: true,
      version: 5,
      documentCount: 4,
      updatedAt: null,
    });
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects the route id %s', async (raw) => {
    ({ app } = await buildApp({ userAuthId: OWNER_SUB, source: makeSource() }));

    const response = await app.inject({ method: 'GET', url: `/job-hunt/profiles/${raw}/jobs` });

    expect(response.statusCode).toBe(400);
  });

  it('checks profile ownership before reading the refresh row', async () => {
    const built = await buildApp({ userAuthId: OWNER_SUB, source: makeSource() });
    app = built.app;
    app.profileService.profileBelongsToUser = jest.fn().mockResolvedValue(false);

    const response = await app.inject({
      method: 'GET',
      url: '/job-hunt/profiles/1/jobs/refresh/7',
    });

    expect(response.statusCode).toBe(404);
    expect(built.getRefreshStatusRow).not.toHaveBeenCalled();
  });
});

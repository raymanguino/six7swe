import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { RetrieveResponse, RetrievedChunkDto } from '@six7swe/knowledge-types';
import {
  createJobRefreshService,
  KnowledgeNotConfiguredError,
} from '../../services/jobHunt/jobRefreshService';
import type { JobKnowledgeSource } from '../../services/jobHunt/knowledgeSource';
import type { InsertProfileJobInput, ProfileJobWithDetails } from '../../db/api/profileJob';
import type { JobInput } from '../../db/api/job';
import type { Job, Profile } from '../../db/schema/jobHunt';
import { matchJob } from '../../services/ai/jobMatch';

jest.mock('../../services/ai/jobMatch', () => ({ matchJob: jest.fn() }));

/**
 * Job matching against the knowledge base: each job is scored with chunks
 * retrieved for its description, the row records the corpus version and the
 * documents used, and a rescore re-evaluates only the stale matches.
 */

const matchJobMock = matchJob as jest.MockedFunction<typeof matchJob>;

const logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
} as unknown as FastifyBaseLogger;

const DOC_A = '11111111-1111-4111-8111-111111111111';
const DOC_B = '22222222-2222-4222-8222-222222222222';

const profile: Profile = {
  id: 1,
  userId: 1,
  name: 'default',
  keywords: ['TypeScript'],
  location: '105149290',
  additionalContext: 'Remote only',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function chunk(documentId: string, filename: string, content: string): RetrievedChunkDto {
  return {
    chunkId: randomUUID(),
    documentId,
    filename,
    heading: null,
    content,
    similarity: 0.8,
  };
}

function makeJob(id: number, hash: string): Job {
  return {
    id,
    sourceId: 'LINKEDIN',
    sourceJobId: `src-${id}`,
    link: `https://example.com/jobs/${id}`,
    company: 'Acme',
    position: `Engineer ${id}`,
    description: 'Build TypeScript services',
    location: 'Remote',
    datePosted: null,
    hash,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeMatch(job: Job, knowledgeVersion: number | null): ProfileJobWithDetails {
  return {
    id: job.id * 10,
    profileId: profile.id,
    jobId: job.id,
    jobHash: job.hash,
    score: 50,
    band: 'MEDIUM',
    explanation: null,
    firstSkillMatch: null,
    secondSkillMatch: null,
    thirdSkillMatch: null,
    summary: null,
    knowledgeVersion,
    evidence: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    job: {
      id: job.id,
      sourceId: job.sourceId,
      sourceJobId: job.sourceJobId,
      link: job.link,
      company: job.company,
      position: job.position,
      description: job.description,
      location: job.location,
      datePosted: job.datePosted,
    },
  };
}

function makeKnowledge(
  version: number,
  retrieve?: RetrieveResponse,
): jest.Mocked<JobKnowledgeSource> {
  return {
    getVersion: jest.fn().mockResolvedValue(version),
    retrieve: jest.fn().mockResolvedValue(
      retrieve ?? {
        version,
        chunks: [
          chunk(DOC_A, 'resume.pdf', 'Led a TypeScript platform team'),
          chunk(DOC_B, 'projects.md', 'Built a RAG service'),
          chunk(DOC_A, 'resume.pdf', 'Five years of Node.js'),
        ],
      },
    ),
    getProfileSummary: jest.fn().mockResolvedValue('Ray, Staff Engineer\nBuilds platforms'),
    getSummary: jest.fn().mockResolvedValue({ documentCount: 2, updatedAt: null }),
  };
}

/** Resolves once the background run has written a terminal status. */
function terminalStatus(): { update: jest.Mock; done: Promise<string> } {
  let resolve: (description: string) => void = () => undefined;
  const done = new Promise<string>((r) => {
    resolve = r;
  });
  const update = jest.fn(async (_id: number, patch: { status?: string; description?: string }) => {
    if (patch.status === 'COMPLETED' || patch.status === 'FAILED') {
      resolve(`${patch.status}: ${patch.description ?? ''}`);
    }
    return true;
  });
  return { update, done };
}

function build(options: {
  knowledge: JobKnowledgeSource | null;
  fetched?: Job[];
  existing?: ProfileJobWithDetails[];
}) {
  const status = terminalStatus();
  const inserted: InsertProfileJobInput[] = [];
  const existing = options.existing ?? [];
  const service = createJobRefreshService({
    jobFetchService: {
      runJobFetch: async (_keywords, _geo, onJobsFetched) => {
        await onJobsFetched((options.fetched ?? []) as unknown as JobInput[]);
      },
    },
    jobService: { bulkInsertJobs: async () => options.fetched ?? [] } as never,
    profileJobService: {
      getProfileJobs: async () => existing,
      getJobsForProfile: async () => existing,
      bulkInsertProfileJobs: async (rows: InsertProfileJobInput[]) => {
        inserted.push(...rows);
        return [];
      },
    } as never,
    profileService: { getProfileById: async () => profile } as never,
    refreshStatusService: {
      getActiveRefreshForProfile: async () => null,
      newProfileRefreshStatus: async () => ({ id: 42 }),
      updateRefreshStatus: status.update,
    } as never,
    knowledge: options.knowledge,
    logger,
  });
  return { service, inserted, done: status.done };
}

beforeEach(() => {
  matchJobMock.mockReset();
  matchJobMock.mockResolvedValue({
    score: 80,
    band: 'TOP',
    analysis: 'Strong fit',
    matchedSkills: ['TypeScript'],
    gaps: [],
    summary: 'Good match',
  });
});

describe('refresh scoring against the knowledge base', () => {
  it('scores with retrieved chunks and records the version and cited documents', async () => {
    const knowledge = makeKnowledge(7);
    const job = makeJob(1, 'h1');
    const { service, inserted, done } = build({ knowledge, fetched: [job] });

    await service.start({ profileId: 1 });
    expect(await done).toMatch(/^COMPLETED/);

    expect(knowledge.retrieve).toHaveBeenCalledWith(
      expect.stringContaining('Build TypeScript services'),
    );
    const context = matchJobMock.mock.calls[0][0].profileContext;
    expect(context).toContain('Builds platforms');
    expect(context).toContain('Led a TypeScript platform team');
    expect(context).toContain('[2] projects.md');

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      job_id: 1,
      knowledge_version: 7,
      evidence: [
        { documentId: DOC_A, filename: 'resume.pdf' },
        { documentId: DOC_B, filename: 'projects.md' },
      ],
    });
  });

  it('rescores an unchanged job whose score is stale', async () => {
    const knowledge = makeKnowledge(8);
    const fresh = makeJob(1, 'h1');
    const stale = makeJob(2, 'h2');
    const { service, inserted, done } = build({
      knowledge,
      fetched: [fresh, stale],
      existing: [makeMatch(fresh, 8), makeMatch(stale, 7)],
    });

    await service.start({ profileId: 1 });
    await done;

    expect(inserted.map((row) => row.job_id)).toEqual([2]);
  });

  it('fails the refresh when the knowledge version cannot be read', async () => {
    const knowledge = makeKnowledge(1);
    knowledge.getVersion.mockRejectedValue(new Error('Knowledge service /version timed out'));
    const { service, inserted, done } = build({ knowledge, fetched: [makeJob(1, 'h1')] });

    await service.start({ profileId: 1 });

    expect(await done).toBe('FAILED: Knowledge service /version timed out');
    expect(inserted).toEqual([]);
  });

  it('fails only the job whose background cannot be retrieved', async () => {
    const knowledge = makeKnowledge(3);
    knowledge.retrieve
      .mockRejectedValueOnce(new Error('retrieve failed'))
      .mockResolvedValueOnce({ version: 3, chunks: [] });
    const { service, inserted, done } = build({
      knowledge,
      fetched: [makeJob(1, 'h1'), makeJob(2, 'h2')],
    });

    await service.start({ profileId: 1 });

    expect(await done).toMatch(/Scored 1 job\(s\), 1 failed/);
    expect(inserted).toHaveLength(1);
  });

  it('scores without background when the knowledge service is not configured', async () => {
    const { service, inserted, done } = build({ knowledge: null, fetched: [makeJob(1, 'h1')] });

    await service.start({ profileId: 1 });
    await done;

    expect(inserted[0]).toMatchObject({ knowledge_version: null, evidence: [] });
    expect(matchJobMock.mock.calls[0][0].profileContext).toContain(
      'No background documents are available.',
    );
  });
});

describe('rescore', () => {
  it('rescores only stale matches, keeping their job hash', async () => {
    const knowledge = makeKnowledge(5);
    const fresh = makeJob(1, 'h1');
    const older = makeJob(2, 'h2');
    const preKnowledge = makeJob(3, 'h3');
    const { service, inserted, done } = build({
      knowledge,
      existing: [makeMatch(fresh, 5), makeMatch(older, 4), makeMatch(preKnowledge, null)],
    });

    await service.rescore({ profileId: 1 });

    expect(await done).toMatch(/^COMPLETED: Rescore completed. Rescored 2 match/);
    expect(inserted.map((row) => [row.job_id, row.job_hash, row.knowledge_version])).toEqual([
      [2, 'h2', 5],
      [3, 'h3', 5],
    ]);
  });

  it('is refused when the knowledge service is not configured', async () => {
    const { service } = build({ knowledge: null });

    await expect(service.rescore({ profileId: 1 })).rejects.toBeInstanceOf(
      KnowledgeNotConfiguredError,
    );
  });
});

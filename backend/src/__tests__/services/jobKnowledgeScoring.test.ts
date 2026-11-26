import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { RetrieveResponse, RetrievedChunkDto } from '@six7swe/knowledge-types';
import {
  createJobRefreshService,
  KnowledgeNotConfiguredError,
  KnowledgeUnavailableError,
} from '../../services/jobHunt/jobRefreshService';
import type { JobKnowledgeSource } from '../../services/jobHunt/knowledgeSource';
import type { InsertProfileJobInput, MatchKey } from '../../db/api/profileJob';
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

const loggerError = jest.fn();
const logger = {
  error: loggerError,
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

/** An existing match: the job row (with its current hash) and the match's scoring key. */
interface ExistingMatch {
  job: Job;
  key: MatchKey;
}

/** `scoredHash` is the hash the match was scored at; the job row holds its current one. */
function makeMatch(
  job: Job,
  knowledgeVersion: number | null,
  scoredHash: string = job.hash,
): ExistingMatch {
  return { job, key: { jobId: job.id, jobHash: scoredHash, knowledgeVersion } };
}

const OWNER_SUB = 'owner-sub';

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
    getBackgroundSummary: jest
      .fn()
      .mockResolvedValue([chunk(DOC_A, 'resume.pdf', 'Staff engineer. Builds platforms')]),
    getSummary: jest.fn().mockResolvedValue({ documentCount: 2, updatedAt: null }),
  };
}

/**
 * Resolves once the background run has written (or tried to write) a
 * terminal status. With `failTerminalWrite` that write rejects, as when the
 * database drops out.
 */
function terminalStatus(failTerminalWrite: boolean): { update: jest.Mock; done: Promise<string> } {
  let resolve: (description: string) => void = () => undefined;
  const done = new Promise<string>((r) => {
    resolve = r;
  });
  const update = jest.fn(
    async (_id: number, _by: string, patch: { status?: string; description?: string }) => {
      if (patch.status === 'COMPLETED' || patch.status === 'FAILED') {
        resolve(`${patch.status}: ${patch.description ?? ''}`);
        if (failTerminalWrite) throw new Error('database unavailable');
      }
      return true;
    },
  );
  return { update, done };
}

function build(options: {
  knowledge: JobKnowledgeSource | null;
  fetched?: Job[];
  existing?: ExistingMatch[];
  failTerminalWrite?: boolean;
  /** The auth subject of the profile's user; the knowledge owner by default. */
  profileAuthId?: string | null;
}) {
  const status = terminalStatus(options.failTerminalWrite ?? false);
  const newProfileRefreshStatus = jest.fn(async () => ({ id: 42 }));
  const inserted: InsertProfileJobInput[] = [];
  const existing = options.existing ?? [];
  const jobsById = new Map(existing.map((match) => [match.job.id, match.job]));
  const service = createJobRefreshService({
    jobFetchService: {
      runJobFetch: async (_keywords, _geo, onJobsFetched) => {
        await onJobsFetched((options.fetched ?? []) as unknown as JobInput[]);
      },
    },
    jobService: {
      bulkInsertJobs: async () => options.fetched ?? [],
      getJobsByIds: async (ids: number[]) =>
        ids.map((id) => jobsById.get(id)).filter((job): job is Job => job !== undefined),
    } as never,
    profileJobService: {
      getMatchKeysForProfile: async () => existing.map((match) => match.key),
      bulkInsertProfileJobs: async (rows: InsertProfileJobInput[]) => {
        inserted.push(...rows);
        return [];
      },
    } as never,
    profileService: {
      getProfileById: async () => profile,
      getProfileOwnerAuthId: async () =>
        options.profileAuthId === undefined ? OWNER_SUB : options.profileAuthId,
    } as never,
    refreshStatusService: {
      getActiveRefreshForProfile: async () => null,
      newProfileRefreshStatus,
      updateRefreshStatus: status.update,
    } as never,
    knowledge: { source: options.knowledge, ownerAuthId: OWNER_SUB },
    logger,
  });
  return { service, inserted, done: status.done, newProfileRefreshStatus };
}

/** Lets the background run's remaining microtasks settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  loggerError.mockReset();
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

describe('owner-only knowledge', () => {
  it.each([
    ['another user', 'someone-else'],
    ['a user with no auth subject', null],
  ])('scores %s on profile fields alone, with no knowledge calls', async (_label, authId) => {
    const knowledge = makeKnowledge(9);
    const { service, inserted, done } = build({
      knowledge,
      fetched: [makeJob(1, 'h1')],
      // A stale-looking key must not trigger a rescore for a non-owner either.
      existing: [makeMatch(makeJob(1, 'h1'), 3)],
      profileAuthId: authId,
    });

    await service.start({ profileId: 1 });
    expect(await done).toMatch(/^COMPLETED/);

    expect(knowledge.getVersion).not.toHaveBeenCalled();
    expect(knowledge.retrieve).not.toHaveBeenCalled();
    expect(knowledge.getBackgroundSummary).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it('stores no knowledge version or evidence for a non-owner new job', async () => {
    const knowledge = makeKnowledge(9);
    const { service, inserted, done } = build({
      knowledge,
      fetched: [makeJob(1, 'h1')],
      profileAuthId: 'someone-else',
    });

    await service.start({ profileId: 1 });
    await done;

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ knowledge_version: null, evidence: [] });
    const context = matchJobMock.mock.calls[0][0].profileContext;
    expect(context).not.toContain('Builds platforms');
    expect(context).toContain('No background documents are available.');
  });

  it('refuses a non-owner rescore like an unconfigured service', async () => {
    const knowledge = makeKnowledge(9);
    const { service, newProfileRefreshStatus } = build({
      knowledge,
      existing: [makeMatch(makeJob(1, 'h1'), 3)],
      profileAuthId: 'someone-else',
    });

    await expect(service.rescore({ profileId: 1 })).rejects.toBeInstanceOf(
      KnowledgeNotConfiguredError,
    );
    expect(knowledge.getVersion).not.toHaveBeenCalled();
    expect(newProfileRefreshStatus).not.toHaveBeenCalled();
  });
});

describe('degraded runs and failed status writes', () => {
  it('stores no knowledge version when the overall background cannot be read', async () => {
    const knowledge = makeKnowledge(6);
    knowledge.getBackgroundSummary.mockRejectedValue(new Error('/retrieve answered 500'));
    const { service, inserted, done } = build({ knowledge, fetched: [makeJob(1, 'h1')] });

    await service.start({ profileId: 1 });
    expect(await done).toMatch(/^COMPLETED/);

    // Scored, but left stale so a later run redoes it with the summary.
    expect(inserted[0]).toMatchObject({ job_id: 1, knowledge_version: null });
  });

  it('logs, and never rejects, when the FAILED status cannot be written', async () => {
    const knowledge = makeKnowledge(1);
    knowledge.getVersion.mockRejectedValue(new Error('version down'));
    const { service, done } = build({
      knowledge,
      fetched: [makeJob(1, 'h1')],
      failTerminalWrite: true,
    });
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    try {
      await service.start({ profileId: 1 });
      expect(await done).toBe('FAILED: version down');
      await settle();

      expect(unhandled).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(
        expect.objectContaining({ refreshId: 42, profileId: 1 }),
        'Could not mark the refresh as failed',
      );
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('logs, and never rejects, when a rescore cannot write its terminal status', async () => {
    const knowledge = makeKnowledge(5);
    const { service, done } = build({
      knowledge,
      existing: [makeMatch(makeJob(1, 'h1'), 4)],
      failTerminalWrite: true,
    });
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    try {
      await service.rescore({ profileId: 1 });
      await done;
      await settle();
      await settle();

      expect(unhandled).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(
        expect.anything(),
        'Could not mark the refresh as failed',
      );
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('rescore', () => {
  it('rescores only stale matches with the current job hash', async () => {
    const knowledge = makeKnowledge(5);
    const fresh = makeJob(1, 'h1');
    // Scored at hash 'old2'; the posting has since changed to 'h2'.
    const older = makeJob(2, 'h2');
    const preKnowledge = makeJob(3, 'h3');
    const { service, inserted, done } = build({
      knowledge,
      existing: [makeMatch(fresh, 5), makeMatch(older, 4, 'old2'), makeMatch(preKnowledge, null)],
    });

    await expect(service.rescore({ profileId: 1 })).resolves.toEqual({ refreshStatusId: 42 });

    expect(await done).toMatch(/^COMPLETED: Rescore completed. Rescored 2 match/);
    expect(inserted.map((row) => [row.job_id, row.job_hash, row.knowledge_version])).toEqual([
      [2, 'h2', 5],
      [3, 'h3', 5],
    ]);
  });

  it('starts nothing when no match is stale', async () => {
    const knowledge = makeKnowledge(5);
    const { service, newProfileRefreshStatus } = build({
      knowledge,
      existing: [makeMatch(makeJob(1, 'h1'), 5)],
    });

    await expect(service.rescore({ profileId: 1 })).resolves.toEqual({ refreshStatusId: null });
    expect(newProfileRefreshStatus).not.toHaveBeenCalled();
    expect(matchJobMock).not.toHaveBeenCalled();
  });

  it('fails the rescore when every stale match fails to evaluate', async () => {
    const knowledge = makeKnowledge(5);
    matchJobMock.mockRejectedValue(new Error('model unavailable'));
    const { service, inserted, done } = build({
      knowledge,
      existing: [makeMatch(makeJob(1, 'h1'), 4), makeMatch(makeJob(2, 'h2'), null)],
    });

    await service.rescore({ profileId: 1 });

    expect(await done).toBe(
      'FAILED: Rescore failed: none of the 2 stale match(es) could be evaluated.',
    );
    expect(inserted).toEqual([]);
  });

  it('is refused with a distinct error when the knowledge service does not answer', async () => {
    const knowledge = makeKnowledge(9);
    knowledge.getVersion.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { service, newProfileRefreshStatus } = build({
      knowledge,
      existing: [makeMatch(makeJob(1, 'h1'), 3)],
    });

    await expect(service.rescore({ profileId: 1 })).rejects.toBeInstanceOf(
      KnowledgeUnavailableError,
    );
    expect(newProfileRefreshStatus).not.toHaveBeenCalled();
  });

  it('is refused when the knowledge service is not configured', async () => {
    const { service } = build({ knowledge: null });

    await expect(service.rescore({ profileId: 1 })).rejects.toBeInstanceOf(
      KnowledgeNotConfiguredError,
    );
  });
});

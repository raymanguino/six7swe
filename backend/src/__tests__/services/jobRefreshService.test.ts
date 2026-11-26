import {
  createJobRefreshService,
  RefreshInProgressError,
  ProfileNotFoundError,
  InvalidProfileLocationError,
} from '../../services/jobHunt/jobRefreshService';
import { ActiveRefreshExistsError } from '../../domain/jobHunt';
import type { Job, Profile } from '../../db/schema/jobHunt';
import type { JobInput } from '../../db/api/job';
import type { FastifyBaseLogger } from 'fastify';
import type { JobKnowledgeSource } from '../../services/jobHunt/knowledgeSource';
import { matchJob } from '../../services/ai/jobMatch';

jest.mock('../../services/ai/jobMatch', () => ({ matchJob: jest.fn() }));

const matchJobMock = matchJob as jest.MockedFunction<typeof matchJob>;

/**
 * Guards the refresh single-flight contract.
 *
 * Two refreshes for the same profile would score the same jobs twice and
 * race on the status row, so a profile may only have one active refresh.
 * The check-then-insert sequence in the service is only a fast path; the
 * database rejects a second concurrent insert, and the service turns that
 * rejection into the same error the fast path raises.
 */

const logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
} as unknown as FastifyBaseLogger;

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    userId: 1,
    name: 'default',
    keywords: ['Software', 'Engineer'],
    location: '105149290',
    additionalContext: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface Stubs {
  getActiveRefreshForProfile: jest.Mock;
  newProfileRefreshStatus: jest.Mock;
  getProfileById: jest.Mock;
}

function buildService(stubs: Stubs) {
  return createJobRefreshService({
    jobFetchService: {
      runJobFetch: async () => undefined,
    },
    jobService: {} as never,
    profileJobService: {} as never,
    profileService: { getProfileById: stubs.getProfileById } as never,
    refreshStatusService: {
      getActiveRefreshForProfile: stubs.getActiveRefreshForProfile,
      newProfileRefreshStatus: stubs.newProfileRefreshStatus,
      updateRefreshStatus: async () => true,
    } as never,
    knowledge: { source: null, ownerAuthId: null },
    logger,
  });
}

function makeStubs(overrides: Partial<Stubs> = {}): Stubs {
  return {
    getActiveRefreshForProfile: jest.fn().mockResolvedValue(null),
    newProfileRefreshStatus: jest.fn().mockResolvedValue({ id: 42 }),
    getProfileById: jest.fn().mockResolvedValue(makeProfile()),
    ...overrides,
  };
}

describe('job refresh single-flight', () => {
  it('starts a refresh when the profile has none running', async () => {
    const stubs = makeStubs();
    const service = buildService(stubs);

    const result = await service.start({ profileId: 1 });

    expect(result).toEqual({ refreshStatusId: 42 });
    expect(stubs.newProfileRefreshStatus).toHaveBeenCalledWith(1, expect.any(String));
  });

  it('rejects a second refresh while one is already active', async () => {
    const stubs = makeStubs({
      getActiveRefreshForProfile: jest.fn().mockResolvedValue({ id: 7, status: 'IN_PROGRESS' }),
    });
    const service = buildService(stubs);

    await expect(service.start({ profileId: 1 })).rejects.toBeInstanceOf(
      RefreshInProgressError,
    );
    expect(stubs.newProfileRefreshStatus).not.toHaveBeenCalled();
  });

  it('rejects a refresh that loses the insert race', async () => {
    // The check saw no active refresh, but another request inserted first.
    // The database rejected this insert, and the service must report it the
    // same way as the fast path.
    const stubs = makeStubs({
      newProfileRefreshStatus: jest
        .fn()
        .mockRejectedValue(new ActiveRefreshExistsError(1)),
    });
    const service = buildService(stubs);

    await expect(service.start({ profileId: 1 })).rejects.toBeInstanceOf(
      RefreshInProgressError,
    );
  });

  it('does not swallow unrelated insert failures', async () => {
    const stubs = makeStubs({
      newProfileRefreshStatus: jest.fn().mockRejectedValue(new Error('connection lost')),
    });
    const service = buildService(stubs);

    await expect(service.start({ profileId: 1 })).rejects.toThrow('connection lost');
  });

  it('rejects a refresh for a profile that does not exist', async () => {
    const stubs = makeStubs({ getProfileById: jest.fn().mockResolvedValue(null) });
    const service = buildService(stubs);

    await expect(service.start({ profileId: 99 })).rejects.toBeInstanceOf(ProfileNotFoundError);
    expect(stubs.newProfileRefreshStatus).not.toHaveBeenCalled();
  });
});

describe('job refresh geo id validation', () => {
  it('rejects a profile whose location is a city name', async () => {
    const stubs = makeStubs({
      getProfileById: jest.fn().mockResolvedValue(makeProfile({ location: 'Toronto, Ontario' })),
    });
    const service = buildService(stubs);

    await expect(service.start({ profileId: 1 })).rejects.toBeInstanceOf(
      InvalidProfileLocationError,
    );
    expect(stubs.newProfileRefreshStatus).not.toHaveBeenCalled();
  });

  it('rejects a profile with no location at all', async () => {
    const stubs = makeStubs({
      getProfileById: jest.fn().mockResolvedValue(makeProfile({ location: null })),
    });
    const service = buildService(stubs);

    await expect(service.start({ profileId: 1 })).rejects.toBeInstanceOf(
      InvalidProfileLocationError,
    );
    expect(stubs.newProfileRefreshStatus).not.toHaveBeenCalled();
  });

  it('accepts a numeric region id', async () => {
    const stubs = makeStubs();
    const service = buildService(stubs);

    await expect(service.start({ profileId: 1 })).resolves.toEqual({ refreshStatusId: 42 });
  });
});

describe('job refresh heartbeat', () => {
  it('claims the row as this service and heartbeats it until the run ends', async () => {
    let finishFetch: () => void = () => undefined;
    const fetchDone = new Promise<void>((resolve) => {
      finishFetch = resolve;
    });
    const heartbeats: Array<[number, string]> = [];
    let beat: () => void = () => undefined;
    const beaten = new Promise<void>((resolve) => {
      beat = resolve;
    });
    const updates: string[] = [];
    const newProfileRefreshStatus = jest.fn().mockResolvedValue({ id: 42 });

    const service = createJobRefreshService({
      // A long run that writes no status while it lasts, like a scoring phase.
      jobFetchService: { runJobFetch: () => fetchDone },
      jobService: {} as never,
      profileJobService: {} as never,
      profileService: { getProfileById: jest.fn().mockResolvedValue(makeProfile()) } as never,
      refreshStatusService: {
        getActiveRefreshForProfile: jest.fn().mockResolvedValue(null),
        newProfileRefreshStatus,
        updateRefreshStatus: async (_id: number, by: string, options: { status?: string }) => {
          if (options.status) updates.push(`${by}:${options.status}`);
          return true;
        },
        heartbeatRefresh: async (id: number, claimedBy: string) => {
          heartbeats.push([id, claimedBy]);
          beat();
          return true;
        },
      } as never,
      knowledge: { source: null, ownerAuthId: null },
      logger,
      claimant: 'api-replica-1',
      heartbeatMs: 5,
    });

    await service.start({ profileId: 1 });
    expect(newProfileRefreshStatus).toHaveBeenCalledWith(1, 'api-replica-1');

    await beaten;
    expect(heartbeats[0]).toEqual([42, 'api-replica-1']);

    finishFetch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updates).toContain('api-replica-1:COMPLETED');
    const afterRun = heartbeats.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(heartbeats).toHaveLength(afterRun);
  });
});

describe('job refresh claim fencing', () => {
  it('stops writing once the row is no longer its claim', async () => {
    const writes: Array<{ status?: string }> = [];
    let ended: () => void = () => undefined;
    const runEnded = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const service = createJobRefreshService({
      jobFetchService: { runJobFetch: async () => ended() },
      jobService: {} as never,
      profileJobService: {} as never,
      profileService: { getProfileById: jest.fn().mockResolvedValue(makeProfile()) } as never,
      refreshStatusService: {
        getActiveRefreshForProfile: jest.fn().mockResolvedValue(null),
        newProfileRefreshStatus: jest.fn().mockResolvedValue({ id: 42 }),
        // Reaped: every fenced write matches no row.
        updateRefreshStatus: async (_id: number, _by: string, options: { status?: string }) => {
          writes.push(options);
          return false;
        },
      } as never,
      knowledge: { source: null, ownerAuthId: null },
      logger,
    });

    await service.start({ profileId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The first write (STARTED) found the claim gone: no fetch, no FAILED write.
    expect(writes).toEqual([expect.objectContaining({ status: 'IN_PROGRESS' })]);
    await expect(Promise.race([runEnded.then(() => 'fetched'), 'not fetched'])).resolves.toBe(
      'not fetched',
    );
  });
});

describe('job refresh claim loss', () => {
  const OWNER_SUB = 'owner-sub';
  const MATCH = {
    score: 80,
    band: 'TOP' as const,
    analysis: 'Strong fit',
    matchedSkills: ['TypeScript'],
    gaps: [],
    summary: 'Good match',
  };

  function makeJob(id: number): Job {
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
      hash: `hash-${id}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  const jobs = [1, 2, 3, 4].map(makeJob);

  function makeKnowledge(version: number): JobKnowledgeSource {
    return {
      getVersion: jest.fn().mockResolvedValue(version),
      retrieve: jest.fn().mockResolvedValue({ version, chunks: [] }),
      getBackgroundSummary: jest.fn().mockResolvedValue([]),
      getSummary: jest.fn().mockResolvedValue({ documentCount: 1, updatedAt: null }),
    };
  }

  /**
   * A run whose heartbeat finds the row reaped while the second of four jobs
   * is being scored: the first job scores normally, and the second's
   * evaluation only returns once the loss has been reported.
   */
  function build() {
    let reportLoss: () => void = () => undefined;
    const lost = new Promise<void>((resolve) => {
      reportLoss = resolve;
    });
    let endRun: () => void = () => undefined;
    const runEnded = new Promise<void>((resolve) => {
      endRun = resolve;
    });
    const statuses: string[] = [];
    const bulkInsertProfileJobs = jest.fn(async () => []);

    matchJobMock.mockReset();
    matchJobMock
      .mockResolvedValueOnce(MATCH)
      .mockImplementationOnce(async () => {
        await lost;
        // Lets the heartbeat's loss handler run before the evaluation returns.
        await new Promise((resolve) => setTimeout(resolve, 0));
        return MATCH;
      })
      .mockResolvedValue(MATCH);

    const service = createJobRefreshService({
      jobFetchService: {
        runJobFetch: async (_keywords, _geo, onJobsFetched) => {
          await onJobsFetched(jobs as unknown as JobInput[]);
        },
      },
      jobService: {
        bulkInsertJobs: async () => jobs,
        getJobsByIds: async (ids: number[]) => jobs.filter((job) => ids.includes(job.id)),
      } as never,
      profileJobService: {
        // Every job was scored against an older corpus, so a rescore redoes them all.
        getMatchKeysForProfile: async () =>
          jobs.map((job) => ({ jobId: job.id, jobHash: 'old', knowledgeVersion: 1 })),
        bulkInsertProfileJobs,
      } as never,
      profileService: {
        getProfileById: async () => makeProfile(),
        getProfileOwnerAuthId: async () => OWNER_SUB,
      } as never,
      refreshStatusService: {
        getActiveRefreshForProfile: async () => null,
        newProfileRefreshStatus: async () => ({ id: 42 }),
        updateRefreshStatus: async (_id: number, _by: string, options: { status?: string }) => {
          if (options.status) statuses.push(options.status);
          return true;
        },
        heartbeatRefresh: async () => {
          // Holds the claim until the second job is being scored, then finds it reaped.
          if (matchJobMock.mock.calls.length < 2) return true;
          reportLoss();
          return false;
        },
      } as never,
      knowledge: { source: makeKnowledge(2), ownerAuthId: OWNER_SUB },
      logger: {
        ...logger,
        error: (_obj: object, msg: string) => {
          if (msg === 'Job refresh failed' || msg === 'Job rescore failed') endRun();
        },
      } as unknown as FastifyBaseLogger,
      matchConcurrency: 1,
      heartbeatMs: 5,
    });

    return { service, runEnded, statuses, bulkInsertProfileJobs };
  }

  it('stops scoring a refresh and stores nothing once the claim is lost', async () => {
    const { service, runEnded, statuses, bulkInsertProfileJobs } = build();

    await service.start({ profileId: 1 });
    await runEnded;

    // Jobs 3 and 4 are never evaluated.
    expect(matchJobMock).toHaveBeenCalledTimes(2);
    expect(bulkInsertProfileJobs).not.toHaveBeenCalled();
    expect(statuses).not.toContain('FAILED');
    expect(statuses).not.toContain('COMPLETED');
  });

  it('stops a rescore the same way', async () => {
    const { service, runEnded, statuses, bulkInsertProfileJobs } = build();

    await expect(service.rescore({ profileId: 1 })).resolves.toEqual({ refreshStatusId: 42 });
    await runEnded;

    expect(matchJobMock).toHaveBeenCalledTimes(2);
    expect(bulkInsertProfileJobs).not.toHaveBeenCalled();
    expect(statuses).not.toContain('FAILED');
    expect(statuses).not.toContain('COMPLETED');
  });
});

import {
  createJobRefreshService,
  RefreshInProgressError,
  ProfileNotFoundError,
  InvalidProfileLocationError,
} from '../../services/jobHunt/jobRefreshService';
import { ActiveRefreshExistsError } from '../../domain/jobHunt';
import type { Profile } from '../../db/schema/jobHunt';
import type { FastifyBaseLogger } from 'fastify';

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

import { FastifyRequest, FastifyReply } from 'fastify';
import { requestContext } from '@fastify/request-context';
import { z } from 'zod';
import type { RefreshStatus } from '../../types';
import { UnauthenticatedUser } from '../../constants';
import { isScoreStale } from '../../domain/jobHunt';
import {
  ProfileNotFoundError,
  RefreshInProgressError,
  InvalidProfileLocationError,
  KnowledgeNotConfiguredError,
  KnowledgeUnavailableError,
} from '../../services/jobHunt/jobRefreshService';
import {
  knowledgeForAuthId,
  type JobKnowledgeSource,
} from '../../services/jobHunt/knowledgeSource';

/** A route id: a positive integer. */
const routeIdSchema = z.coerce.number().int().positive();

/** The parsed id, or null when the path segment is not a positive integer. */
function parseRouteId(raw: unknown): number | null {
  const parsed = routeIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function profileIdParam(request: FastifyRequest): number | null {
  return parseRouteId((request.params as { profileId?: unknown }).profileId);
}

/** What a caller who may not see the knowledge base is told about it. */
const KNOWLEDGE_NOT_AVAILABLE = { configured: false } as const;

/**
 * The knowledge source for a profile, or null when its user is not the
 * knowledge owner (or the service is not configured). Decided from the
 * profile's user row, the same way background runs decide it.
 */
async function knowledgeForProfile(
  request: FastifyRequest,
  profileId: number,
): Promise<JobKnowledgeSource | null> {
  const access = request.server.jobKnowledge;
  if (!access.source) return null;
  const authId = await request.server.profileService.getProfileOwnerAuthId(profileId);
  return knowledgeForAuthId(access, authId);
}

/**
 * The current knowledge corpus version, or null when the service does not
 * answer. A listing must not fail because of it: the matches are still worth
 * showing, just without staleness.
 */
async function currentKnowledgeVersion(
  request: FastifyRequest,
  source: JobKnowledgeSource,
): Promise<number | null> {
  try {
    return await source.getVersion();
  } catch (error) {
    request.log.warn({ err: error }, 'Could not read the knowledge version');
    return null;
  }
}

/** The authenticated user's local id. Routes here are private, so it is set. */
function currentUserId(_request: FastifyRequest): number {
  const user = requestContext.get('user');
  if (!user || user === UnauthenticatedUser) {
    throw new Error('Unauthenticated');
  }
  const id = Number(user.id);
  if (Number.isNaN(id)) {
    throw new Error('Unauthenticated');
  }
  return id;
}

/**
 * Confirms the profile belongs to the caller.
 *
 * Every route that takes a profile id goes through this, so a caller cannot
 * reach another user's profile by guessing an id.
 */
async function assertOwnsProfile(request: FastifyRequest, profileId: number): Promise<void> {
  const owns = await request.server.profileService.profileBelongsToUser(
    profileId,
    currentUserId(request),
  );
  if (!owns) {
    throw new ProfileNotFoundError(profileId);
  }
}

/**
 * Starts a refresh for a profile.
 *
 * The pipeline itself lives in `services/jobHunt/jobRefreshService`; this
 * handler only starts it and hands back the id of the refresh row to poll.
 */
export async function runRefreshJobsForProfile(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  try {
    const profileId = profileIdParam(request);
    if (profileId === null) {
      return reply.code(400).send({ error: 'Invalid profile ID' });
    }

    await assertOwnsProfile(request, profileId);

    const { refreshStatusId } = await request.server.jobRefreshService.start({ profileId });

    return reply.code(202).send({ refreshStatusId });
  } catch (error) {
    if (error instanceof ProfileNotFoundError) {
      return reply.code(404).send({ error: 'Profile not found' });
    }
    if (error instanceof RefreshInProgressError) {
      return reply.code(409).send({ error: 'A refresh is already running for this profile.' });
    }
    if (error instanceof InvalidProfileLocationError) {
      return reply.code(400).send({
        error:
          'This profile has no valid LinkedIn geo id. Set it to a numeric region id before refreshing.',
      });
    }
    request.log.error({ err: error }, 'Error running job fetch');
    return reply.code(500).send({ error: 'Failed to run job fetch.' });
  }
}

/**
 * Rescores the profile's stale matches against the current knowledge version.
 *
 * Shares the refresh row and its single-flight guard, so the client polls the
 * same status endpoint as for a refresh. A profile whose user is not the
 * knowledge owner gets the same 503 as when the service is not configured.
 */
export async function runRescoreForProfile(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  try {
    const profileId = profileIdParam(request);
    if (profileId === null) {
      return reply.code(400).send({ error: 'Invalid profile ID' });
    }

    await assertOwnsProfile(request, profileId);

    const { refreshStatusId } = await request.server.jobRefreshService.rescore({ profileId });

    // No stale matches: nothing was started.
    if (refreshStatusId === null) {
      return reply.code(204).send();
    }
    return reply.code(202).send({ refreshStatusId });
  } catch (error) {
    if (error instanceof ProfileNotFoundError) {
      return reply.code(404).send({ error: 'Profile not found' });
    }
    if (error instanceof RefreshInProgressError) {
      return reply.code(409).send({ error: 'A refresh is already running for this profile.' });
    }
    if (error instanceof KnowledgeNotConfiguredError) {
      return reply.code(503).send({ error: 'The knowledge base is not available.' });
    }
    if (error instanceof KnowledgeUnavailableError) {
      request.log.warn({ err: error }, 'The knowledge service is unreachable for a rescore');
      return reply
        .code(503)
        .send({ error: 'The knowledge service is unavailable. Try again shortly.' });
    }
    request.log.error({ err: error }, 'Error starting a rescore');
    return reply.code(500).send({ error: 'Failed to start the rescore.' });
  }
}

/**
 * What job matches are scored against: the knowledge base's document count,
 * when it last changed and its corpus version. Counts and dates only, never
 * document names or content, and only to the knowledge owner; everyone else
 * gets `{ configured: false }`.
 */
export async function getKnowledgeStatus(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const user = requestContext.get('user');
  const authId = user && user !== UnauthenticatedUser ? (user.authId ?? null) : null;
  const source = knowledgeForAuthId(request.server.jobKnowledge, authId);
  if (!source) {
    return reply.code(200).send(KNOWLEDGE_NOT_AVAILABLE);
  }
  try {
    const [version, summary] = await Promise.all([source.getVersion(), source.getSummary()]);
    return reply.code(200).send({
      configured: true,
      version,
      documentCount: summary?.documentCount ?? null,
      updatedAt: summary?.updatedAt ?? null,
    });
  } catch (error) {
    request.log.warn({ err: error }, 'Could not read the knowledge status');
    return reply.code(503).send({ error: 'The knowledge base is unavailable.' });
  }
}

/**
 * Returns the progress of a refresh.
 *
 * Ownership of the profile is checked before the refresh row is read, and
 * the row must belong to that profile; otherwise a caller could read another
 * profile's refresh by guessing an id.
 */
export async function getRefreshStatus(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  try {
    const params = request.params as { profileId?: unknown; refreshId?: unknown };
    const profileId = parseRouteId(params.profileId);
    const refreshId = parseRouteId(params.refreshId);

    if (profileId === null || refreshId === null) {
      return reply.code(400).send({ error: 'Invalid profile or refresh ID' });
    }

    await assertOwnsProfile(request, profileId);

    const refreshStatus: RefreshStatus | null =
      await request.server.refreshStatusService.getRefreshStatus(refreshId);

    if (!refreshStatus || refreshStatus.profileId !== profileId) {
      return reply.code(404).send({ error: 'Refresh status not found' });
    }

    // The claim columns (which process runs it) stay internal.
    const { id, status, step, description, createdAt, updatedAt } = refreshStatus;
    return reply
      .code(200)
      .send({ refreshStatus: { id, profileId, status, step, description, createdAt, updatedAt } });
  } catch (error) {
    if (error instanceof ProfileNotFoundError) {
      return reply.code(404).send({ error: 'Refresh status not found' });
    }
    request.log.error({ err: error }, 'Error fetching refresh status');
    return reply.code(500).send({ error: 'Failed to fetch refresh status.' });
  }
}

/**
 * The scored matches for a profile. For the knowledge owner's profiles each
 * match carries its staleness and the documents cited as evidence; for every
 * other profile no knowledge detail is sent at all.
 */
export async function getJobsForProfile(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  try {
    const profileId = profileIdParam(request);
    if (profileId === null) {
      return reply.code(400).send({ error: 'Invalid profile ID' });
    }

    await assertOwnsProfile(request, profileId);

    const [matches, source] = await Promise.all([
      request.server.profileJobService.getJobsForProfile(profileId),
      knowledgeForProfile(request, profileId),
    ]);

    if (!source) {
      // Rows scored while this user was the owner may still carry evidence;
      // none of it, nor any version, leaves the server.
      const jobs = matches.map((match) => ({
        ...match,
        knowledgeVersion: null,
        evidence: [],
        stale: false,
      }));
      return reply.code(200).send({ jobs, knowledge: KNOWLEDGE_NOT_AVAILABLE });
    }

    const version = await currentKnowledgeVersion(request, source);
    const jobs = matches.map((match) => ({
      ...match,
      stale: isScoreStale(match.knowledgeVersion, version),
    }));

    return reply.code(200).send({
      jobs,
      knowledge: {
        configured: true,
        version,
        staleCount: jobs.filter((job) => job.stale).length,
      },
    });
  } catch (error) {
    if (error instanceof ProfileNotFoundError) {
      return reply.code(404).send({ error: 'Profile not found' });
    }
    request.log.error({ err: error }, 'Error fetching jobs for profile');
    return reply.code(500).send({ error: 'Failed to fetch jobs for profile.' });
  }
}

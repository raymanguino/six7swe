import { FastifyRequest, FastifyReply } from 'fastify';
import { requestContext } from '@fastify/request-context';
import type { ProfileJob, RefreshStatus } from '../../types';
import { UnauthenticatedUser } from '../../constants';
import {
  ProfileNotFoundError,
  RefreshInProgressError,
  InvalidProfileLocationError,
} from '../../services/jobHunt/jobRefreshService';

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
async function assertOwnsProfile(
  request: FastifyRequest,
  profileId: number,
): Promise<void> {
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
    const { profileId } = request.params as { profileId: string };
    const profileIdNum = parseInt(profileId, 10);

    if (Number.isNaN(profileIdNum)) {
      return reply.code(400).send({ error: 'Invalid profile ID' });
    }

    await assertOwnsProfile(request, profileIdNum);

    const { refreshStatusId } = await request.server.jobRefreshService.start({
      profileId: profileIdNum,
    });

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
 * Returns the progress of a refresh.
 *
 * The refresh row must belong to the profile in the path; otherwise a caller
 * could read another profile's refresh by guessing an id.
 */
export async function getRefreshStatus(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  try {
    const { profileId, refreshId } = request.params as {
      profileId: string;
      refreshId: string;
    };
    const profileIdNum = parseInt(profileId, 10);
    const refreshIdNum = parseInt(refreshId, 10);

    if (Number.isNaN(profileIdNum) || Number.isNaN(refreshIdNum)) {
      return reply.code(400).send({ error: 'Invalid profile or refresh ID' });
    }

    const refreshStatus: RefreshStatus | null =
      await request.server.refreshStatusService.getRefreshStatus(refreshIdNum);

    if (!refreshStatus || refreshStatus.profileId !== profileIdNum) {
      return reply.code(404).send({ error: 'Refresh status not found' });
    }

    await assertOwnsProfile(request, profileIdNum);

    return reply.code(200).send({ refreshStatus });
  } catch (error) {
    if (error instanceof ProfileNotFoundError) {
      return reply.code(404).send({ error: 'Refresh status not found' });
    }
    request.log.error({ err: error }, 'Error fetching refresh status');
    return reply.code(500).send({ error: 'Failed to fetch refresh status.' });
  }
}

export async function getJobsForProfile(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  try {
    const { profileId } = request.params as { profileId: string };
    const profileIdNum = parseInt(profileId, 10);

    if (Number.isNaN(profileIdNum)) {
      return reply.code(400).send({ error: 'Invalid profile ID' });
    }

    await assertOwnsProfile(request, profileIdNum);

    const jobs: ProfileJob[] =
      await request.server.profileJobService.getJobsForProfile(profileIdNum);

    return reply.code(200).send({ jobs });
  } catch (error) {
    if (error instanceof ProfileNotFoundError) {
      return reply.code(404).send({ error: 'Profile not found' });
    }
    request.log.error({ err: error }, 'Error fetching jobs for profile');
    return reply.code(500).send({ error: 'Failed to fetch jobs for profile.' });
  }
}

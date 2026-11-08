import { FastifyRequest, FastifyReply } from 'fastify';
import { requestContext } from '@fastify/request-context';
import { z } from 'zod';
import { UnauthenticatedUser } from '../../constants';
import { LINKEDIN_GEO_ID_PATTERN } from '../../domain/jobHunt';

/**
 * The LinkedIn region id used to search for postings.
 *
 * It has to be a numeric region id, not a city name: a city name produces a
 * search that silently returns nothing. Validating it here means the profile
 * is rejected at save time rather than failing later during a refresh.
 */
const locationSchema = z
  .string()
  .trim()
  .max(255)
  .regex(LINKEDIN_GEO_ID_PATTERN, 'LinkedIn geo id must be a numeric region id')
  .nullable()
  .default(null);

const createProfileSchema = z.object({
  name: z.string().min(1).max(255),
  keywords: z.array(z.string().min(1)).max(50).default([]),
  location: locationSchema,
  additionalContext: z.string().max(10_000).nullable().default(null),
  resume: z.string().max(200_000).nullable().default(null),
});

const updateProfileSchema = createProfileSchema.partial();

/** The authenticated user's local id. Routes here are private, so it is set. */
function currentUserId(request: FastifyRequest): number {
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

export async function getAllProfiles(request: FastifyRequest, reply: FastifyReply) {
  try {
    const profiles = await request.server.profileService.getProfilesForUser(currentUserId(request));
    return reply.code(200).send({ profiles });
  } catch (error) {
    request.log.error({ err: error }, 'Error fetching profiles');
    return reply.code(500).send({ error: 'Failed to fetch profiles' });
  }
}

export async function getProfileById(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { profileId } = request.params as { profileId: string };
    const profileIdNum = parseInt(profileId, 10);

    if (Number.isNaN(profileIdNum)) {
      return reply.code(400).send({ error: 'Invalid profile ID' });
    }

    const profile = await request.server.profileService.getProfileForUser(
      profileIdNum,
      currentUserId(request),
    );
    if (!profile) {
      return reply.code(404).send({ error: 'Profile not found' });
    }

    return reply.code(200).send({ profile });
  } catch (error) {
    request.log.error({ err: error }, 'Error fetching profile');
    return reply.code(500).send({ error: 'Failed to fetch profile' });
  }
}

export async function createProfileHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const parsed = createProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid profile payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const profile = await request.server.profileService.createProfile({
      userId: currentUserId(request),
      ...parsed.data,
    });

    return reply.code(201).send({ profile });
  } catch (error) {
    request.log.error({ err: error }, 'Error creating profile');
    return reply.code(500).send({ error: 'Failed to create profile' });
  }
}

export async function updateProfileHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { profileId } = request.params as { profileId: string };
    const profileIdNum = parseInt(profileId, 10);

    if (Number.isNaN(profileIdNum)) {
      return reply.code(400).send({ error: 'Invalid profile ID' });
    }

    const parsed = updateProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid profile payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const profile = await request.server.profileService.updateProfile(
      profileIdNum,
      currentUserId(request),
      parsed.data,
    );
    if (!profile) {
      return reply.code(404).send({ error: 'Profile not found' });
    }

    return reply.code(200).send({ profile });
  } catch (error) {
    request.log.error({ err: error }, 'Error updating profile');
    return reply.code(500).send({ error: 'Failed to update profile' });
  }
}

export async function deleteProfileHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { profileId } = request.params as { profileId: string };
    const profileIdNum = parseInt(profileId, 10);

    if (Number.isNaN(profileIdNum)) {
      return reply.code(400).send({ error: 'Invalid profile ID' });
    }

    const deleted = await request.server.profileService.deleteProfile(
      profileIdNum,
      currentUserId(request),
    );
    if (!deleted) {
      return reply.code(404).send({ error: 'Profile not found' });
    }

    return reply.code(204).send();
  } catch (error) {
    request.log.error({ err: error }, 'Error deleting profile');
    return reply.code(500).send({ error: 'Failed to delete profile' });
  }
}

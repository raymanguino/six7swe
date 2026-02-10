import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { SixSevenService } from '../service';

export async function getAllProfiles(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const server = request.server as FastifyInstance & SixSevenService;

  try {
    const profiles = await server.profileService.getAllProfiles();
    reply.code(200).send({ profiles });
  } catch (error) {
    server.log.error(error, 'Error calling getAllProfiles():');
    reply.code(500).send({ error: 'Failed to fetch profiles' });
  }
}

export async function getProfileById(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const server = request.server as FastifyInstance & SixSevenService;

  try {
    const { profileId: _profileId } = request.params as { profileId: string };
    const profileId = parseInt(_profileId);

    if (isNaN(profileId)) {
      reply.code(400).send({ error: 'Invalid profile ID' });
      return;
    }

    const profile = await server.profileService.getProfileById(profileId);
    if (!profile) {
      reply.code(404).send({ error: 'Profile not found' });
      return;
    }

    return reply.code(200).send({ profile });
  } catch (error) {
    server.log.error(error, 'Error fetching profile:');
    reply.code(500).send({ error: 'Failed to fetch profile' });
  }
}

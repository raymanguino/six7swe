import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { SixSevenService } from '../service';

export async function getAllProfiles(request: FastifyRequest, reply: FastifyReply) {
  const server = request.server as FastifyInstance & SixSevenService;
  let client;

  try {
    client = await server.pg.connect();

    const profiles = await server.profileService.getAllProfiles(client);

    reply.code(200).send({ profiles });
  } catch (error) {
    server.log.error(error, 'Error calling getAllProfiles():');
    reply.code(500);
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function getProfileById(request: FastifyRequest, reply: FastifyReply) {
  const server = request.server as FastifyInstance & SixSevenService;
  let client;

  try {
    const { profileId: _profileId } = request.params as { profileId: string };
    const profileId = parseInt(_profileId);

    if (isNaN(profileId)) {
      reply.code(400).send({ error: 'Invalid profile ID' });
      return;
    }

    client = await server.pg.connect();

    const profile = await server.profileService.getProfileById(client, profileId);
    if (!profile) {
      reply.code(404).send({ error: 'Profile not found' });
      return;
    }
    
    return { profile };
  } catch (error) {
    server.log.error(error, 'Error fetching profile:');
    reply.code(500);
  } finally {
    if (client) {
      client.release();
    }
  }
}

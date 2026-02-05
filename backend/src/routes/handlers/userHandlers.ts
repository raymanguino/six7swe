import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { SixSevenService } from '../service';

export async function getAllUsers(request: FastifyRequest, reply: FastifyReply) {
  const server = request.server as FastifyInstance & SixSevenService;
  let client;

  try {
    client = await server.pg.connect();

    const users = await server.userService.getAllUsers(client);
    return reply.code(200).send({ users });
  } catch (error) {
    server.log.error(error, 'Error fetching users:');
    reply.code(500).send({ error: 'Failed to fetch users.' });
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function getUserById(request: FastifyRequest, reply: FastifyReply) {
  const server = request.server as FastifyInstance & SixSevenService;
  let client;
  
  try {
    const { id } = request.params as { id: string };
    const userId = parseInt(id);
    
    if (isNaN(userId)) {
      reply.code(400);
      return { error: 'Invalid user ID' };
    }

    client = await server.pg.connect();

    const user = await server.userService.getUserById(client, userId);
    if (!user) {
      reply.code(404);
      return { error: 'User not found' };
    }
    
    return { user };
  } catch (error) {
    server.log.error(error, 'Error fetching user:');
    reply.code(500).send({ error: 'Failed to fetch user' });
  } finally {
    if (client) {
      client.release();
    }
  }
}

import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { SixSevenService } from '../service';

export async function getAllUsers(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const server = request.server as FastifyInstance & SixSevenService;

  try {
    const users = await server.userService.getAllUsers();
    return reply.code(200).send({ users });
  } catch (error) {
    server.log.error(error, 'Error fetching users:');
    reply.code(500).send({ error: 'Failed to fetch users.' });
  }
}

export async function getUserById(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const server = request.server as FastifyInstance & SixSevenService;

  try {
    const { id } = request.params as { id: string };
    const userId = parseInt(id);

    if (isNaN(userId)) {
      reply.code(400);
      return { error: 'Invalid user ID' };
    }

    const user = await server.userService.getUserById(userId);
    return reply.code(200).send({ user });
  } catch (error) {
    if (error instanceof Error && error.message === 'User not found') {
      reply.code(404);
      return { error: 'User not found' };
    }
    server.log.error(error, 'Error fetching user:');
    reply.code(500).send({ error: 'Failed to fetch user' });
  }
}

import { FastifyRequest, FastifyReply } from 'fastify';
import { requestContext } from '@fastify/request-context';
import { UnauthenticatedUser } from '../../constants';

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

/**
 * Returns the caller's own user record.
 *
 * The job-hunter has no admin surface, so there is no endpoint that lists
 * every user.
 */
export async function getCurrentUser(request: FastifyRequest, reply: FastifyReply) {
  try {
    const user = await request.server.userService.getUserById(currentUserId(request));
    return reply.code(200).send({ user });
  } catch (error) {
    if (error instanceof Error && error.message === 'User not found') {
      return reply.code(404).send({ error: 'User not found' });
    }
    request.log.error({ err: error }, 'Error fetching user');
    return reply.code(500).send({ error: 'Failed to fetch user.' });
  }
}

/**
 * Returns a user by id, but only the caller's own record.
 */
export async function getUserById(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = request.params as { id: string };
    const userId = parseInt(id, 10);

    if (Number.isNaN(userId)) {
      return reply.code(400).send({ error: 'Invalid user ID' });
    }

    if (userId !== currentUserId(request)) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const user = await request.server.userService.getUserById(userId);
    return reply.code(200).send({ user });
  } catch (error) {
    if (error instanceof Error && error.message === 'User not found') {
      return reply.code(404).send({ error: 'User not found' });
    }
    request.log.error({ err: error }, 'Error fetching user');
    return reply.code(500).send({ error: 'Failed to fetch user.' });
  }
}

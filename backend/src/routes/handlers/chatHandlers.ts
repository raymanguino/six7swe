import { FastifyRequest, FastifyReply } from 'fastify';
import { INPUT_LIMITS } from '../../constants';
import { chatWithContext } from '../../services/minimaxService';

export async function chatHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const body = request.body as { message: string; history?: Array<{ role: string; content: string }> };
    const { message, history } = body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return reply.code(400).send({ error: 'Message is required' });
    }
    const trimmed = message.trim();
    if (trimmed.length > INPUT_LIMITS.chatMessage) {
      return reply.code(400).send({ error: `Message must be at most ${INPUT_LIMITS.chatMessage} characters` });
    }

    const response = await chatWithContext({ message: trimmed, history });

    return reply.code(200).send({ response });
  } catch (error) {
    request.log.error(error, 'Error in chat handler');
    return reply.code(500).send({ error: 'Failed to process chat message' });
  }
}
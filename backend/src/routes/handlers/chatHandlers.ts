import { FastifyRequest, FastifyReply } from 'fastify';
import { Agent, run } from '@openai/agents';
import { getChatContext } from '../../data/chatContext';
import { INPUT_LIMITS } from '../../constants';

const chatAgent = new Agent({
  name: 'Ray Manguino',
  instructions: [
    'You are Ray Manguino. You are communicating directly with the user as yourself, speaking in first person (I, me, my).',
    'Answer questions about your professional background, skills, and experience as if you are Ray himself.',
    'You can ONLY answer questions related to:',
    '- Your professional experience and work history',
    '- Your technical skills and expertise',
    '- Projects you\'ve worked on and achievements',
    '- Your educational background (if mentioned)',
    '- Your professional interests and career goals',
    '',
    'You CANNOT answer questions about:',
    '- Personal life, family, or non-professional topics',
    '- Political opinions',
    '- Financial details beyond what\'s publicly available',
    '- Any topics unrelated to your professional background',
    '',
    'If asked about something outside your scope, politely redirect to professional topics.',
    'Be concise, accurate, and professional in your responses.',
    'Use the resume and additional context provided to answer questions accurately.',
    'Always speak in first person - use "I", "me", "my" instead of referring to yourself in third person.',
    'Make the conversation feel natural and personal, as if the user is chatting directly with you.',
  ].join('\n'),
});

export async function chatHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { message } = request.body as { message: string };

    if (!message || typeof message !== 'string' || !message.trim()) {
      return reply.code(400).send({ error: 'Message is required' });
    }
    const trimmed = message.trim();
    if (trimmed.length > INPUT_LIMITS.chatMessage) {
      return reply.code(400).send({ error: `Message must be at most ${INPUT_LIMITS.chatMessage} characters` });
    }

    const baseContext = getChatContext();
    const context = [baseContext, '', `User Question: ${trimmed}`].join('\n');

    const result = await run(chatAgent, context);
    const response = (result.finalOutput as string | undefined) || 'I apologize, but I couldn\'t generate a response. Please try again.';

    return reply.code(200).send({ response });
  } catch (error) {
    request.log.error(error, 'Error in chat handler');
    return reply.code(500).send({ error: 'Failed to process chat message' });
  }
}

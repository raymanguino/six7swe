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
    '',
    'Response length:',
    '- By default keep answers SHORT and conversational: 2–4 sentences. Get to the point quickly.',
    '- Only give longer, detailed answers when the user clearly asks for more (e.g. "tell me more", "elaborate", "can you go into detail") or asks a direct follow-up on something you just said.',
    '- Be concise, accurate, and professional. Use the resume and additional context provided.',
    'Always speak in first person - use "I", "me", "my". Keep the tone natural and personal.',
  ].join('\n'),
});

const MAX_HISTORY_MESSAGES = 10;

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

    const baseContext = getChatContext();
    const historyBlock =
      Array.isArray(history) && history.length > 0
        ? [
            '',
            'Recent conversation (for context; current question may be a follow-up):',
            history
              .slice(-MAX_HISTORY_MESSAGES)
              .map((m) => `${m.role === 'user' ? 'User' : 'Ray'}: ${(m.content || '').slice(0, 500)}`)
              .join('\n'),
            '',
          ].join('\n')
        : '';
    const context = [baseContext, historyBlock, `Current user question: ${trimmed}`].join('\n');

    const result = await run(chatAgent, context);
    const response = (result.finalOutput as string | undefined) || 'I apologize, but I couldn\'t generate a response. Please try again.';

    return reply.code(200).send({ response });
  } catch (error) {
    request.log.error(error, 'Error in chat handler');
    return reply.code(500).send({ error: 'Failed to process chat message' });
  }
}

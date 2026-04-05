import { FastifyRequest, FastifyReply } from 'fastify';
import { run } from '@openai/agents';
import { getChatContext } from '../../data/chatContext';
import { INPUT_LIMITS } from '../../constants';
import { createChatAgent } from '../../services/agents/agentDefinitions';
import { withPortfolioMcpServers } from '../../services/mcpAgentServer';

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

    const baseContext = await getChatContext();
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

    const result = await withPortfolioMcpServers(async (servers) => {
      const agent = createChatAgent(servers);
      return run(agent, context);
    });
    const response = (result.finalOutput as string | undefined) || 'I apologize, but I couldn\'t generate a response. Please try again.';

    return reply.code(200).send({ response });
  } catch (error) {
    request.log.error(error, 'Error in chat handler');
    return reply.code(500).send({ error: 'Failed to process chat message' });
  }
}

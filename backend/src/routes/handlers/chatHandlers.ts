import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { INPUT_LIMITS } from '../../constants';
import { chatWithContext } from '../../services/ai';
import { MiniMaxApiError } from '../../services/minimaxService';

const MESSAGE_REQUIRED = 'Message is required';
const MESSAGE_TOO_LONG = `Message must be at most ${INPUT_LIMITS.chatMessage} characters`;
const INVALID_HISTORY = 'Invalid chat history';

/** The prompt only uses the last 10 turns; 20 leaves room without trusting the client. */
export const MAX_CHAT_HISTORY_ITEMS = 20;
export const MAX_CHAT_HISTORY_CONTENT_CHARS = INPUT_LIMITS.chatMessage;

/**
 * The frontend sends the whole conversation, and assistant answers can run
 * past the message limit. So history is bounded by keeping the most recent
 * turns and truncating long ones, rather than rejecting a long conversation.
 * Every entry is validated before the older ones are dropped, so anything
 * that is not a list of `{ role: 'user' | 'assistant', content }` is
 * rejected, however far back the bad entry sits. The request body limit
 * bounds the list itself.
 */
const HistorySchema = z
  .array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().transform((s) => s.slice(0, MAX_CHAT_HISTORY_CONTENT_CHARS)),
    }),
  )
  .transform((items) => items.slice(-MAX_CHAT_HISTORY_ITEMS));

export const ChatRequestSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, MESSAGE_REQUIRED)
    .max(INPUT_LIMITS.chatMessage, MESSAGE_TOO_LONG),
  history: HistorySchema.optional(),
});

function firstError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.path[0] === 'history') return INVALID_HISTORY;
  if (issue?.path[0] === 'message' && issue.code === 'too_big') return MESSAGE_TOO_LONG;
  return MESSAGE_REQUIRED;
}

export async function chatHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const parsed = ChatRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: firstError(parsed.error) });
    }
    const { message, history } = parsed.data;

    const response = await chatWithContext({ message, history, log: request.log });

    return reply.code(200).send({ response });
  } catch (error) {
    request.log.error({ err: error }, 'Error in chat handler');
    if (error instanceof MiniMaxApiError) {
      return reply
        .code(502)
        .send({ error: 'The AI service is temporarily unavailable. Please try again.' });
    }
    return reply
      .code(500)
      .send({ error: 'Something went wrong while processing your message. Please try again.' });
  }
}

import { getChatContext } from '../../data/chatContext';
import { chatCompletion } from '../minimaxService';
import { CHAT_SYSTEM_PROMPT } from './prompts/chat';

export interface ChatOptions {
  message: string;
  history?: Array<{ role: string; content: string }>;
}

const MAX_HISTORY_MESSAGES = 10;

/**
 * Answers a chat message grounded in the portfolio owner's resume and
 * content sections.
 */
export async function chatWithContext(options: ChatOptions): Promise<string> {
  const { message, history } = options;
  const trimmed = message.trim();

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

  const fullContext = [baseContext, historyBlock, `Current user question: ${trimmed}`].join('\n');

  return chatCompletion(
    [
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      { role: 'user', content: fullContext },
    ],
    { reasoning_effort: 'medium' },
  );
}

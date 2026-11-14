import { getPortfolioDataSource } from '../../config/portfolioMcp';
import {
  getChatContext,
  getKnowledgeChatContext,
  type ChatHistory,
  type ContextLogger,
} from '../../data/chatContext';
import { chatCompletion } from '../minimaxService';
import { CHAT_SYSTEM_PROMPT } from './prompts/chat';

export interface ChatOptions {
  message: string;
  history?: ChatHistory;
  /** Receives a warning when chat falls back to profile-only context. */
  log?: ContextLogger;
}

const MAX_HISTORY_MESSAGES = 10;

/**
 * The context block for one chat turn. With `PORTFOLIO_DATA_SOURCE=knowledge`
 * it is a compact profile summary plus the chunks retrieved for this question
 * (profile-only if retrieval is down); otherwise the whole resume and every
 * content section.
 */
export async function getContextForChat(options: ChatOptions): Promise<string> {
  if (getPortfolioDataSource() === 'knowledge') {
    const result = await getKnowledgeChatContext({
      message: options.message,
      history: options.history,
      log: options.log,
    });
    return result.context;
  }
  return getChatContext();
}

/** The messages sent to the model, given the context block. */
export function buildChatMessages(
  baseContext: string,
  message: string,
  history?: ChatHistory,
): Array<{ role: string; content: string }> {
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

  const fullContext = [baseContext, historyBlock, `Current user question: ${message.trim()}`].join(
    '\n',
  );

  return [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    { role: 'user', content: fullContext },
  ];
}

/**
 * Answers a chat message grounded in the portfolio owner's background.
 */
export async function chatWithContext(options: ChatOptions): Promise<string> {
  const trimmed = options.message.trim();
  const baseContext = await getContextForChat({ ...options, message: trimmed });
  return chatCompletion(buildChatMessages(baseContext, trimmed, options.history), {
    reasoning_effort: 'medium',
  });
}

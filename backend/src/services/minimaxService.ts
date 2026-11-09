import { z } from 'zod';
import { redactSecrets } from '../util';

interface MiniMaxMessage {
  role: string;
  content: string;
}

interface MiniMaxResponse {
  id: string;
  choices: Array<{
    finish_reason: string;
    index: number;
    message: {
      content: string;
      role: 'assistant';
      name?: string;
      reasoning_content?: string;
    };
  }>;
  model: string;
  object: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
}

/** MiniMax reports most failures inside a 200 response body; this marks them as upstream errors. */
export class MiniMaxApiError extends Error {
  readonly code: number;

  constructor(message: string, code = 0) {
    super(message);
    this.name = 'MiniMaxApiError';
    this.code = code;
  }
}

const MINI_MAX_API_URL = 'https://api.minimax.io/v1/chat/completions';
const MINI_MAX_MODEL = 'MiniMax-M3.1-Flash';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface CompletionOptions {
  model?: string;
  max_tokens?: number;
  reasoning_effort?: ReasoningEffort;
}

function getMiniMaxConfig() {
  const apiKey = process.env.MINIMAX_API_KEY;
  const secondaryApiKey = process.env.MINIMAX_API_KEY_SECONDARY;

  if (!apiKey) {
    throw new Error('MINIMAX_API_KEY is not configured');
  }

  return { apiKey, secondaryApiKey };
}

export async function chatCompletion(
  messages: MiniMaxMessage[],
  options?: CompletionOptions
): Promise<string> {
  const { apiKey, secondaryApiKey } = getMiniMaxConfig();

  const model = options?.model ?? MINI_MAX_MODEL;
  const max_completion_tokens = options?.max_tokens ?? 4096;
  const reasoning_effort = options?.reasoning_effort ?? 'low';

  const body = JSON.stringify({
    model,
    messages,
    max_completion_tokens,
    reasoning_effort,
  });

  async function sendRequest(key: string): Promise<Response> {
    return fetch(MINI_MAX_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body,
    });
  }

  let response = await sendRequest(apiKey);
  if (response.status === 429 && secondaryApiKey) {
    response = await sendRequest(secondaryApiKey);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new MiniMaxApiError(
      `MiniMax API error: ${response.status} ${response.statusText} - ${redactSecrets(errorText)}`,
      response.status,
    );
  }

  const data = (await response.json()) as MiniMaxResponse;

  if (data.base_resp && data.base_resp.status_code !== 0) {
    throw new MiniMaxApiError(
      `MiniMax API error ${data.base_resp.status_code}: ${redactSecrets(data.base_resp.status_msg)}`,
      data.base_resp.status_code,
    );
  }

  const choice = data.choices?.[0];
  const content = choice?.message?.content?.trim();

  if (!content) {
    if (choice?.finish_reason === 'length') {
      throw new MiniMaxApiError(
        'MiniMax response hit the token limit before producing an answer',
      );
    }
    throw new MiniMaxApiError('No content in MiniMax response');
  }

  return content;
}

/**
 * Performs a completion and validates the result against `outputSchema`.
 *
 * The schema is always applied: a malformed, truncated or unexpected model
 * response is rejected rather than passed through as if it were valid.
 */
export async function structuredCompletion<T>(
  messages: MiniMaxMessage[],
  // zod 4 dropped `z.ZodTypeDef` and reordered the generics to
  // `ZodType<Output, Input, Internals>`.
  outputSchema: z.ZodType<T, unknown>,
  options?: CompletionOptions
): Promise<T> {
  const response = await chatCompletion(messages, {
    ...options,
    max_tokens: options?.max_tokens ?? 2048,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(response) as unknown;
  } catch {
    throw new Error('Failed to parse MiniMax response as JSON');
  }

  return outputSchema.parse(parsed);
}

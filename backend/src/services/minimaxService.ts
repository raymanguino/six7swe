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
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
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

/**
 * How long a single completion may take.
 *
 * Without a bound, a request that never gets an answer waits forever: the
 * server holds the connection open and the caller waits with it. In a
 * request handler that is a socket that never closes, and in a CI job it
 * is a run that burns its whole timeout and is killed before it can
 * report anything.
 *
 * The bound has to be generous enough for a long reasoning pass over a
 * large diff, and short enough that a stuck call fails while there is
 * still time to say so.
 */
const COMPLETION_TIMEOUT_MS = 120_000;

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The tokens one completion used, as MiniMax reported them. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** The reasoning share of `completionTokens`, when MiniMax reports it. */
  reasoningTokens: number | null;
}

export interface CompletionOptions {
  model?: string;
  max_tokens?: number;
  reasoning_effort?: ReasoningEffort;
  /** Overrides the request timeout. Used by callers that need longer. */
  timeoutMs?: number;
  /**
   * Receives the token usage of the response, when it reports any.
   *
   * Called before the answer is checked, so a response that ran out of
   * tokens or failed validation still reports what it cost.
   */
  onUsage?: (usage: TokenUsage) => void;
}

function getMiniMaxConfig() {
  const apiKey = process.env.MINIMAX_API_KEY;
  const secondaryApiKey = process.env.MINIMAX_API_KEY_SECONDARY;

  if (!apiKey) {
    throw new Error('MINIMAX_API_KEY is not configured');
  }

  return { apiKey, secondaryApiKey };
}

/**
 * Describes where the completion tokens went, for a response that ran out.
 *
 * A reasoning model spends its thinking from the same budget as its answer,
 * so an empty answer at the limit usually means the thinking used it all.
 * The split is what tells a budget that is too small from a prompt that is
 * too large, so it belongs in the error rather than in a guess.
 */
function describeTokenUse(usage: MiniMaxResponse['usage'], limit: number): string {
  if (!usage) return ` (limit ${limit} tokens; no usage reported)`;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  const split = reasoning === undefined ? '' : `, ${reasoning} of them reasoning`;
  return ` (${usage.completion_tokens} of ${limit} completion tokens used${split}; prompt ${usage.prompt_tokens} tokens)`;
}

export async function chatCompletion(
  messages: MiniMaxMessage[],
  options?: CompletionOptions,
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

  const timeoutMs = options?.timeoutMs ?? COMPLETION_TIMEOUT_MS;
  // One deadline for the whole call: the primary request, the fallback
  // request and the reading of the response body all share it.
  const signal = AbortSignal.timeout(timeoutMs);

  async function sendRequest(key: string): Promise<Response> {
    return fetch(MINI_MAX_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body,
      signal,
    });
  }

  let data: MiniMaxResponse;

  try {
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

    data = (await response.json()) as MiniMaxResponse;
  } catch (error: unknown) {
    // The deadline can fire while connecting or while the body is being
    // read, and the error that surfaces differs between the two. Ask the
    // signal rather than inspecting the error, so every case is reported
    // as a timeout and callers map it to the same upstream failure as any
    // other MiniMax error.
    if (signal.aborted) {
      throw new MiniMaxApiError(`MiniMax did not respond within ${timeoutMs / 1000} seconds`);
    }
    throw error;
  }

  if (data.base_resp && data.base_resp.status_code !== 0) {
    throw new MiniMaxApiError(
      `MiniMax API error ${data.base_resp.status_code}: ${redactSecrets(data.base_resp.status_msg)}`,
      data.base_resp.status_code,
    );
  }

  if (data.usage && options?.onUsage) {
    options.onUsage({
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens ?? null,
    });
  }

  const choice = data.choices?.[0];
  const content = choice?.message?.content?.trim();

  if (!content) {
    if (choice?.finish_reason === 'length') {
      throw new MiniMaxApiError(
        `MiniMax response hit the token limit before producing an answer${describeTokenUse(data.usage, max_completion_tokens)}`,
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
  options?: CompletionOptions,
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

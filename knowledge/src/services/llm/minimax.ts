import { z } from 'zod';
import { redactSecrets } from '../../lib/redact.js';

/**
 * One chat completion from MiniMax, the app's LLM provider, called the way
 * the backend's chat calls it (`backend/src/services/minimaxService.ts`).
 * Shared by the profile drafter (#86) and the eval answerer (#85).
 *
 * Failures are `ModelError`s whose message is fixed and safe to show the
 * owner; MiniMax's own text goes to `detail`, redacted, for the logs only.
 */

export class ModelError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ModelError';
  }
}

/** MiniMax reports most failures inside a 200 body (`base_resp`). */
const MiniMaxResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({ content: z.string().nullable().optional() }).optional(),
      }),
    )
    .optional(),
  base_resp: z.object({ status_code: z.number(), status_msg: z.string().optional() }).optional(),
});

/** Reasoning tokens share this budget with the answer, so it is generous. */
export const MINIMAX_MAX_COMPLETION_TOKENS = 8192;
export const MINIMAX = 'MiniMax';
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * A reasoning model may put its thinking before the answer. A `<think>` block
 * that never closes (cut off at the token limit) is all thinking, so nothing
 * is left.
 */
export function stripThinking(content: string): string {
  return content.replace(/^\s*<think>(?:[\s\S]*?<\/think>|[\s\S]*$)/i, '').trim();
}

export interface MiniMaxOptions {
  /** The chat completions endpoint, e.g. `https://api.minimax.io/v1/chat/completions`. */
  url: string;
  apiKey: string;
  /** Tried once when the primary key gets a 429. */
  secondaryApiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
  /** One deadline for the whole call, the retry and the body included. */
  timeoutMs?: number;
  /** Stops the call early as well (the caller's own timeout, or its work being abandoned). */
  signal?: AbortSignal;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** The answer's text, thinking removed. Throws a `ModelError` on any failure or an empty answer. */
export async function completeWithMiniMax(
  options: MiniMaxOptions,
  messages: ChatMessage[],
  /** The message when the token limit cut the answer off. */
  lengthMessage = `${MINIMAX} hit its token limit before answering.`,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = JSON.stringify({
    model: options.model,
    messages,
    max_completion_tokens: MINIMAX_MAX_COMPLETION_TOKENS,
    reasoning_effort: 'medium',
  });
  const deadline = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const send = (key: string) =>
    fetchImpl(options.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      signal,
    });

  // Provider text goes to the logs only, and never with a key in it.
  const redact = (text: string) => redactSecrets(text, [options.apiKey, options.secondaryApiKey]);

  let json: unknown;
  try {
    let res = await send(options.apiKey);
    if (res.status === 429 && options.secondaryApiKey) {
      // Release the first response's connection before the retry.
      await res.body?.cancel().catch(() => undefined);
      res = await send(options.secondaryApiKey);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // The deadline can strike while the error body is read.
      if (signal.aborted) throw new Error('timed out reading the error body');
      throw new ModelError(`${MINIMAX} returned an error (status ${res.status}).`, redact(text));
    }
    try {
      json = await res.json();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ModelError(`${MINIMAX} sent a response that was not JSON.`, undefined, {
        cause: error,
      });
    }
  } catch (error) {
    if (error instanceof ModelError) throw error;
    // Ask the signal: the deadline can strike while connecting or reading.
    throw new ModelError(
      signal.aborted ? `${MINIMAX} did not answer in time.` : `${MINIMAX} could not be reached.`,
      undefined,
      { cause: error },
    );
  }

  const parsed = MiniMaxResponseSchema.safeParse(json);
  if (!parsed.success) throw new ModelError(`${MINIMAX} sent an unexpected response.`);
  const { base_resp: baseResp, choices } = parsed.data;
  if (baseResp && baseResp.status_code !== 0) {
    throw new ModelError(
      `${MINIMAX} returned an error (code ${baseResp.status_code}).`,
      baseResp.status_msg === undefined ? undefined : redact(baseResp.status_msg),
    );
  }
  const choice = choices?.[0];
  const content = stripThinking(choice?.message?.content ?? '');
  if (!content) {
    if (choice?.finish_reason === 'length') throw new ModelError(lengthMessage);
    throw new ModelError(`${MINIMAX} sent an empty answer.`);
  }
  return content;
}

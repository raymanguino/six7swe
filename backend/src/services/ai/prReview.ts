import { z } from 'zod';
import { structuredCompletion } from '../minimaxService';
import type { ReviewFinding } from '../../domain/qa';
import { PR_REVIEW_SYSTEM_PROMPT } from './prompts/prReview';

/**
 * The model response for a pull request review.
 *
 * The schema validates the *types*, not the presentation. There is no cap
 * on the findings list: the completion budget already bounds how many
 * findings a response can contain, and a cap here would reject an
 * otherwise valid response and turn the whole review into a failure.
 *
 * There is no `verdict` field either. The gate is decided from the
 * findings by the domain module, in pure code. A second, model-supplied
 * verdict is a second source of truth that can disagree with the first,
 * and an `approve` value in the type invites a later caller to map it
 * straight onto a GitHub review event the agent is not allowed to post.
 */
export const prReviewResponseSchema = z.object({
  summary: z.string().min(1),
  findings: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'major', 'minor', 'nit']),
        file: z.string().nullable().default(null),
        line: z.number().int().nullable().default(null),
        message: z.string().min(1),
      }),
    )
    .default([]),
});

export type PrReviewResponse = z.infer<typeof prReviewResponseSchema>;

export interface PrReviewOutput {
  summary: string;
  /**
   * Every finding the model returned.
   *
   * The list is not trimmed here. Trimming before the gate has seen the
   * list would let a blocker written after the cut be lost entirely, and
   * trimming before the sanitizer has run would throw away real findings
   * that sat behind hallucinated ones. The caller trims for display, after
   * the gate has decided.
   */
  findings: ReviewFinding[];
}

export interface PrReviewInput {
  prTitle: string;
  prDescription: string;
  /** The diff text, already prepared by the domain diff builder. */
  diff: string;
}

/**
 * Any opening or closing tag of one of the sections the prompt is built
 * from, in any case and with any spacing or attributes.
 */
const SECTION_TAG = /<(\s*\/?\s*(?:pull_request_title|pull_request_description|diff)\b[^>]*)>/gi;

/**
 * Escapes every section tag inside author-written content.
 *
 * Without this, a description containing "</pull_request_description>"
 * followed by "<diff>" opens a second, forged diff section, and anything
 * inside it, including notices in the positions the prompt calls genuine,
 * reads as the tooling's own output. With every such tag written as
 * "&lt;...>", the only real tags in the message are the ones written here,
 * and the prompt can say so without exceptions.
 */
export function escapeSectionTags(content: string): string {
  return content.replace(SECTION_TAG, '&lt;$1>');
}

/**
 * Asks the model to review a pull request diff.
 *
 * Reuses `structuredCompletion`, so the JSON parsing, the Zod validation and
 * MiniMax's habit of reporting failures inside a `200` body are all handled
 * by the existing transport. A malformed model response raises: it is never
 * replaced with a fabricated result.
 *
 * The pull request title, description and diff are written by the pull
 * request author, so they are the one input an attacker fully controls.
 * They are wrapped in labelled delimiters, any delimiter inside them is
 * escaped, and the system prompt says plainly that the content inside
 * them is data under review and never instructions.
 */
export async function reviewPullRequest(input: PrReviewInput): Promise<PrReviewOutput> {
  const prompt = [
    '<pull_request_title>',
    escapeSectionTags(input.prTitle),
    '</pull_request_title>',
    '',
    '<pull_request_description>',
    escapeSectionTags(input.prDescription) || '(none)',
    '</pull_request_description>',
    '',
    '<diff>',
    escapeSectionTags(input.diff),
    '</diff>',
  ].join('\n');

  const parsed = await structuredCompletion(
    [
      { role: 'system', content: PR_REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    prReviewResponseSchema,
    {
      max_tokens: 8192,
      reasoning_effort: 'medium',
      // A review asks for a lot more than a chat reply: 8192 tokens with
      // medium reasoning over a large diff. The default bound is too
      // tight for that, and a timeout here would turn a slow model into a
      // failed review on every large pull request.
      timeoutMs: 300_000,
    },
  );

  return {
    summary: parsed.summary,
    findings: parsed.findings.map((finding) => ({
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      message: finding.message,
    })),
  };
}

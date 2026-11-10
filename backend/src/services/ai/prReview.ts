import { z } from 'zod';
import { structuredCompletion } from '../minimaxService';
import type { FindingSeverity } from '../../domain/qa';
import { PR_REVIEW_SYSTEM_PROMPT } from './prompts/prReview';

/**
 * The model response for a pull request review.
 *
 * The schema validates the *types*, not the presentation: capping the
 * findings list here would reject an otherwise valid response just because
 * the model listed nine findings instead of eight. The list is trimmed to
 * `MAX_FINDINGS` afterwards.
 */
export const prReviewResponseSchema = z.object({
  verdict: z.enum(['approve', 'request_changes', 'comment']),
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
    .max(20)
    .default([]),
});

export type PrReviewResponse = z.infer<typeof prReviewResponseSchema>;

export interface PrReviewFinding {
  severity: FindingSeverity;
  file: string | null;
  line: number | null;
  message: string;
}

export interface PrReviewOutput {
  verdict: PrReviewResponse['verdict'];
  summary: string;
  findings: PrReviewFinding[];
}

/** Maximum number of findings kept in the result. */
export const MAX_FINDINGS = 8;

export interface PrReviewInput {
  prTitle: string;
  prDescription: string;
  /** The diff text, already prepared by the domain diff builder. */
  diff: string;
}

/**
 * Asks the model to review a pull request diff.
 *
 * Reuses `structuredCompletion`, so the JSON parsing, the Zod validation and
 * MiniMax's habit of reporting failures inside a `200` body are all handled
 * by the existing transport. A malformed model response raises: it is never
 * replaced with a fabricated result.
 */
export async function reviewPullRequest(input: PrReviewInput): Promise<PrReviewOutput> {
  const prompt = [
    `Pull request title: ${input.prTitle}`,
    '',
    'Pull request description:',
    input.prDescription || '(none)',
    '',
    '---',
    'Diff to review:',
    input.diff,
  ].join('\n');

  const parsed = await structuredCompletion(
    [
      { role: 'system', content: PR_REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    prReviewResponseSchema,
    { max_tokens: 8192, reasoning_effort: 'medium' },
  );

  return {
    verdict: parsed.verdict,
    summary: parsed.summary,
    findings: parsed.findings.slice(0, MAX_FINDINGS).map((finding) => ({
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      message: finding.message,
    })),
  };
}

import { z } from 'zod';
import { structuredCompletion } from '../minimaxService';
import { FITCHECK_SYSTEM_PROMPT } from './prompts/fitcheck';

const fitCheckItemSchema = z.object({
  heading: z.string(),
  details: z.string(),
});

const fitCheckResponseSchema = z.object({
  snarky_preamble: z.string().nullable().default(null),
  verdict: z.enum(['strong', 'weak']),
  where_i_match: z.array(fitCheckItemSchema).max(5).nullable().default(null),
  gaps_to_note: z.array(fitCheckItemSchema).max(5).nullable().default(null),
  where_i_dont_fit: z.array(fitCheckItemSchema).max(5).nullable().default(null),
  what_does_transfer: z.string().nullable().default(null),
  recommendation: z.string().default(''),
});

export type FitCheckOutput = z.infer<typeof fitCheckResponseSchema>;

const MAX_ITEMS = 5;

/**
 * Produces a first-person fit assessment for a job description.
 *
 * The response is validated against a schema, so a malformed model response
 * surfaces as an error instead of being silently replaced with a fake verdict.
 */
export async function fitCheckWithContext(
  jobDescription: string,
  profileContext: string,
): Promise<FitCheckOutput> {
  const prompt = [
    profileContext,
    '',
    '---',
    'Job Description to analyze:',
    jobDescription,
  ].join('\n');

  const parsed = await structuredCompletion(
    [
      { role: 'system', content: FITCHECK_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    fitCheckResponseSchema,
    { max_tokens: 8192, reasoning_effort: 'high' },
  );

  return {
    snarky_preamble: parsed.snarky_preamble,
    verdict: parsed.verdict,
    where_i_match: capItems(parsed.where_i_match),
    gaps_to_note: capItems(parsed.gaps_to_note),
    where_i_dont_fit: capItems(parsed.where_i_dont_fit),
    what_does_transfer: parsed.what_does_transfer ?? '',
    recommendation: parsed.recommendation ?? '',
  };
}

function capItems(
  items: Array<{ heading: string; details: string }> | null,
): Array<{ heading: string; details: string }> | null {
  if (!Array.isArray(items)) return null;
  return items.slice(0, MAX_ITEMS);
}

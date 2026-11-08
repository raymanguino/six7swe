import { z } from 'zod';
import { structuredCompletion } from '../minimaxService';
import { scoreBand, type MatchBand } from '../../domain/jobHunt';
import { JOB_MATCH_SYSTEM_PROMPT } from './prompts/jobMatch';

/**
 * The canonical job matcher.
 *
 * Both the public `POST /job-match` endpoint and the job-hunter refresh
 * pipeline call this function, so a job is scored the same way wherever it
 * comes from. The band is derived from the score in the domain layer rather
 * than asked of the model, so the classification can never disagree with the
 * number it came from.
 */

/**
 * Response shape for a match.
 *
 * The schema validates the *types*, not the presentation: capping the skill
 * lists here would reject an otherwise valid response just because the model
 * listed six gaps instead of five. A generous hard limit still guards against
 * runaway output; the lists are trimmed to `MAX_LIST_ITEMS` afterwards.
 */
export const jobMatchResponseSchema = z.object({
  score: z.number().int().min(0).max(100),
  analysis: z.string().min(1),
  matchedSkills: z.array(z.string()).max(20).default([]),
  gaps: z.array(z.string()).max(20).default([]),
  summary: z.string().min(1),
});

export type JobMatchResponse = z.infer<typeof jobMatchResponseSchema>;

export type JobMatchResult = JobMatchResponse & { band: MatchBand };

/** Maximum number of skills or gaps kept in the result. */
export const MAX_LIST_ITEMS = 5;

export interface JobMatchInput {
  /** The full job description text. */
  jobDescription: string;
  /** Candidate details. Callers decide where these come from. */
  profileContext: string;
}

export async function matchJob(input: JobMatchInput): Promise<JobMatchResult> {
  const prompt = [
    'Candidate Profile:',
    input.profileContext,
    '',
    'Job Description:',
    input.jobDescription,
  ].join('\n');

  const response = await structuredCompletion(
    [
      { role: 'system', content: JOB_MATCH_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    jobMatchResponseSchema,
    { max_tokens: 2048, reasoning_effort: 'medium' },
  );

  return {
    ...response,
    matchedSkills: response.matchedSkills.slice(0, MAX_LIST_ITEMS),
    gaps: response.gaps.slice(0, MAX_LIST_ITEMS),
    band: scoreBand(response.score),
  };
}

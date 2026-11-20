/**
 * The version of the review prompt (#146).
 *
 * A finding is only comparable with findings produced by the same prompt:
 * #107 changed the layering rule the model reviews against, and #109
 * changed how steering is reported. The stats line records the version
 * each run used, so the verdict table can filter by it instead of relying
 * on prose that says which rows came before which change.
 *
 * Add a row to `REVIEW_PROMPT_VERSIONS` (the current version is its last
 * row) whenever the system prompt's text changes
 * (`backend/src/services/ai/prompts/prReview.ts`). A test pins the
 * prompt's hash to the version, so a change that forgets the bump fails.
 */

export interface PromptVersionInfo {
  version: number;
  /** Where the version came from: the change that introduced it. */
  since: string;
  /** What changed, in a phrase. */
  change: string;
}

/** Every version of the review prompt, oldest first, numbered from 1. */
export const REVIEW_PROMPT_VERSIONS = [
  {
    version: 1,
    since: 'the first prompt (2026-11-10)',
    change: 'layering rule "infrastructure owns every side effect"',
  },
  {
    version: 2,
    since: 'PR #107 (2026-11-13)',
    change: "the backend's real layers, described by path",
  },
  {
    version: 3,
    since: 'PR #109 (2026-11-13)',
    change: 'steering reported as one minor finding; the auth surface named',
  },
  {
    version: 4,
    since: 'PR #133 (2026-11-14)',
    change: 'frontend stack versions corrected',
  },
  {
    version: 5,
    since: 'issue #213 (2026-11-20)',
    change: 'the portfolioService layering exception removed with the service',
  },
] as const satisfies readonly PromptVersionInfo[];

/** The version of the prompt the agent runs with now: the last one in the history. */
export const REVIEW_PROMPT_VERSION: number =
  REVIEW_PROMPT_VERSIONS[REVIEW_PROMPT_VERSIONS.length - 1].version;

/** Whether a value names a version in the history. */
export function isKnownPromptVersion(value: unknown): value is number {
  return REVIEW_PROMPT_VERSIONS.some((entry) => entry.version === value);
}

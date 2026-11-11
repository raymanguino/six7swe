/**
 * Reviews a pull request and posts a single review on it.
 *
 * The script is the seam between the pure decision logic in
 * `backend/src/domain/qa/` and the two side effects - calling the model and
 * talking to GitHub. It reads the pull request's changed files, asks the
 * model for a review, decides what the gate should do, and posts exactly
 * one review.
 *
 * The gate outcome decides the exit code: `pass` exits 0, everything else
 * exits 1. That is what makes the job a required status check, so the
 * check goes red when the agent finds a blocking defect.
 *
 * Usage:
 *   pnpm --filter @six7swe/backend qa:review
 *
 * Environment:
 *   MINIMAX_API_KEY     required, the MiniMax key the model is called with
 *   GITHUB_TOKEN        required, the token the review is posted with
 *   GITHUB_REPOSITORY   required, in "owner/repo" form
 *   PR_NUMBER           required, the pull request number
 *   PR_HEAD_SHA         required, the pull request head SHA
 *   PR_TITLE            optional, defaults to empty
 *   PR_DESCRIPTION      optional, defaults to empty
 */

import { z } from 'zod';
import {
  buildReviewDiff,
  decideGate,
  renderFailureBody,
  renderReviewBody,
  reviewEventForGate,
  sanitizeFindings,
  sortFindingsBySeverity,
  type ChangedFile,
} from '../src/domain/qa';
import { reviewPullRequest } from '../src/services/ai/prReview';
import { listChangedFiles, upsertReviewComment } from '../src/services/github/prClient';

/**
 * A variable that must be present and not empty.
 *
 * The empty case matters: a workflow step that passes an unset secret
 * through as an empty string would otherwise pass validation and only
 * fail later, at the model call, which would post a fail-closed review
 * on every pull request instead of naming the misconfigured variable.
 */
function required(name: string, hint?: string) {
  const message = hint ? `${name} is required, ${hint}` : `${name} is required`;
  return z.string({ error: message }).min(1, message);
}

/**
 * The configuration the script needs.
 *
 * Validated with Zod at startup, so a missing variable fails fast with a
 * message naming it. There is no default for the API key or the token:
 * running without them would fail later and less clearly.
 *
 * The error messages are written out rather than left as Zod's defaults,
 * because the reader of this message is whoever left a workflow step
 * unconfigured. "MINIMAX_API_KEY is required" says what to do;
 * "expected string, received undefined" does not.
 */
const envSchema = z.object({
  MINIMAX_API_KEY: required('MINIMAX_API_KEY'),
  GITHUB_TOKEN: required('GITHUB_TOKEN'),
  GITHUB_REPOSITORY: required('GITHUB_REPOSITORY', 'in "owner/repo" form').regex(
    /^[^/]+\/[^/]+$/,
    'GITHUB_REPOSITORY must be in "owner/repo" form',
  ),
  PR_NUMBER: z.coerce
    .number({ error: 'PR_NUMBER is required' })
    .int('PR_NUMBER must be an integer')
    .positive('PR_NUMBER must be a positive integer'),
  PR_HEAD_SHA: required('PR_HEAD_SHA'),
  PR_TITLE: z.string().default(''),
  PR_DESCRIPTION: z.string().default(''),
});

/**
 * How much of the diff the model is shown.
 *
 * The per-file budget keeps one large file from crowding out the rest; the
 * total budget bounds the whole prompt. Both are generous enough that a
 * normal pull request is shown in full.
 */
const DIFF_BUDGET = {
  perFileChars: 8_000,
  totalChars: 60_000,
  skipPatchesFor: [] as string[],
};

/**
 * The mode the agent runs in.
 *
 * Phase 1 is `comment-only`: the agent reports and never blocks, so the
 * check is always green. Phase 2 flips this to `enforce`, which is a
 * one-word change plus the settings toggle described in the phase 2 issue.
 */
const REVIEW_MODE = 'comment-only' as const;

function parseEnv(): z.infer<typeof envSchema> {
  const parsed = envSchema.safeParse({
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    PR_NUMBER: process.env.PR_NUMBER,
    PR_HEAD_SHA: process.env.PR_HEAD_SHA,
    PR_TITLE: process.env.PR_TITLE,
    PR_DESCRIPTION: process.env.PR_DESCRIPTION,
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration - ${details}`);
  }

  return parsed.data;
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split('/');
  return { owner, repo };
}

async function main(): Promise<void> {
  const env = parseEnv();
  const { owner, repo } = splitRepository(env.GITHUB_REPOSITORY);

  try {
    const changedFiles: ChangedFile[] = await listChangedFiles(
      owner,
      repo,
      env.PR_NUMBER,
      env.GITHUB_TOKEN,
    );

    const diff = buildReviewDiff(changedFiles, DIFF_BUDGET);

    process.stdout.write(
      `Reviewing PR #${env.PR_NUMBER}: ${changedFiles.length} file(s), ${diff.length} character(s) of diff sent to the model.\n`,
    );

    const review = await reviewPullRequest({
      prTitle: env.PR_TITLE,
      prDescription: env.PR_DESCRIPTION,
      diff,
    });

    // The gate sanitizes the findings itself, but the review body shows the
    // same sanitized list, so the reviewer reads exactly what was decided on.
    const findings = sortFindingsBySeverity(sanitizeFindings(review.findings, changedFiles));

    const gate = decideGate({
      findings: review.findings,
      changedFiles,
      mode: REVIEW_MODE,
      reviewCompleted: true,
    });

    process.stdout.write(
      `Model returned ${review.findings.length} finding(s); ${findings.length} survived sanitizing.\n`,
    );
    for (const finding of findings) {
      process.stdout.write(`  ${finding.severity}: ${finding.message}\n`);
    }
    process.stdout.write(`Gate outcome: ${gate}\n`);

    const event = reviewEventForGate(gate);

    const body = renderReviewBody(review.summary, findings, gate, env.PR_HEAD_SHA);

    const action = await upsertReviewComment(owner, repo, env.PR_NUMBER, env.GITHUB_TOKEN, {
      commit_id: env.PR_HEAD_SHA,
      body,
    });

    process.stdout.write(`Posted one ${event} review on PR #${env.PR_NUMBER} (${action}).\n`);

    if (gate !== 'pass') {
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    // The review could not be completed. That is a fail-closed outcome,
    // and it has to be reported as an error on the pull request rather
    // than as a finding about the code: a broken agent must never look
    // like a defect in the pull request.
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`QA review failed: ${reason}\n`);

    await postFailureReview(env, owner, repo, reason);

    process.exitCode = 1;
  }
}

/**
 * Posts the fail-closed review.
 *
 * It is best effort: if the failure was in the GitHub call itself, there
 * is nothing left to post with. The exit code is what gates the merge,
 * so a failure to post does not change the outcome.
 */
async function postFailureReview(
  env: z.infer<typeof envSchema>,
  owner: string,
  repo: string,
  reason: string,
): Promise<void> {
  try {
    const body = renderFailureBody(reason, env.PR_HEAD_SHA);

    const action = await upsertReviewComment(owner, repo, env.PR_NUMBER, env.GITHUB_TOKEN, {
      commit_id: env.PR_HEAD_SHA,
      body,
    });

    process.stdout.write(`Posted one fail-closed review on PR #${env.PR_NUMBER} (${action}).\n`);
  } catch (postError: unknown) {
    const message = postError instanceof Error ? postError.message : String(postError);
    process.stderr.write(`Could not post the fail-closed review: ${message}\n`);
  }
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`QA review failed: ${reason}\n`);
  process.exitCode = 1;
});

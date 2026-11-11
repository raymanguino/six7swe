/**
 * Reviews a pull request and posts a single review on it.
 *
 * The script is the seam between the pure decision logic in
 * `backend/src/domain/qa/` and the two side effects - calling the model and
 * talking to GitHub. It reads the pull request's changed files, asks the
 * model for a review, decides what the gate should do, and posts exactly
 * one review.
 *
 * The gate outcome decides the exit code, and the mode decides whether the
 * gate blocks at all. That is what makes the job a required status check:
 * in phase 2 the check goes red when the agent finds a blocking defect.
 *
 * Usage:
 *   pnpm --filter @six7swe/backend qa:review
 *
 * Environment:
 *   MINIMAX_API_KEY     required, the MiniMax key the model is called with
 *   GITHUB_TOKEN        required, the token the review is posted with
 *   GITHUB_REPOSITORY   required, in "owner/repo" form
 *   PR_NUMBER           required, the pull request number
 *   PR_HEAD_SHA         required, the pull request head SHA at event time
 *   PR_TITLE            optional, defaults to empty
 *   PR_DESCRIPTION      optional, defaults to empty
 *   REVIEW_MODE         optional, "comment-only" (default) or "enforce"
 */

import { z } from 'zod';
import {
  buildReviewDiff,
  decideGate,
  flattenText,
  gateBlocksMerge,
  renderFailureBody,
  renderReviewBody,
  reviewEventForGate,
  sanitizeFindings,
  sortFindingsBySeverity,
  type ChangedFile,
} from '../src/domain/qa';
import { reviewPullRequest } from '../src/services/ai/prReview';
import {
  dismissReview,
  findAgentChangeRequests,
  getPullRequest,
  listChangedFiles,
  submitReview,
  upsertReviewComment,
} from '../src/services/github/prClient';

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
  /**
   * The mode the agent runs in.
   *
   * Phase 1 is `comment-only`: the agent reports and never blocks, so the
   * check is always green. Phase 2 flips `REVIEW_MODE` to `enforce` in the
   * workflow, which is a settings change rather than a code change.
   *
   * The default is the safe one: an unset or misspelled value cannot
   * silently start enforcing.
   */
  REVIEW_MODE: z.enum(['comment-only', 'enforce']).default('comment-only'),
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

/** How many times the head SHA is re-checked when the pull request moves. */
const HEAD_READ_ATTEMPTS = 3;

/**
 * Writes a line to the workflow log.
 *
 * The Actions runner interprets a line that starts with "::" as a
 * workflow command. A finding message is model output that was written
 * from attacker-controlled diff content, so it can contain "::error::"
 * or "::add-mask::" and have it carried out. The colons are encoded, and
 * the text is flattened to one line so it cannot start a new line at all.
 */
function logLine(text: string): void {
  process.stdout.write(`${flattenText(text).replace(/::/g, '%3A%3A')}\n`);
}

function parseEnv(): z.infer<typeof envSchema> {
  const parsed = envSchema.safeParse({
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    PR_NUMBER: process.env.PR_NUMBER,
    PR_HEAD_SHA: process.env.PR_HEAD_SHA,
    PR_TITLE: process.env.PR_TITLE,
    PR_DESCRIPTION: process.env.PR_DESCRIPTION,
    REVIEW_MODE: process.env.REVIEW_MODE,
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

interface HeadSnapshot {
  headSha: string;
  changedFiles: ChangedFile[];
}

/**
 * Reads the changed files and the commit they belong to.
 *
 * The files endpoint always returns the pull request's *current* head, so
 * a push that lands while the review is running would attach a review of
 * the new code to the commit the workflow was triggered for. The head is
 * read before and after the files, and the pair is only accepted when
 * both reads agree: that proves the files belong to that commit.
 */
async function readHeadSnapshot(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
): Promise<HeadSnapshot> {
  for (let attempt = 1; attempt <= HEAD_READ_ATTEMPTS; attempt += 1) {
    const before = await getPullRequest(owner, repo, pullNumber, token);
    const changedFiles = await listChangedFiles(owner, repo, pullNumber, token);
    const after = await getPullRequest(owner, repo, pullNumber, token);

    if (before.headSha === after.headSha) {
      return { headSha: before.headSha, changedFiles };
    }

    logLine(
      `The pull request moved while it was being read (${before.headSha} -> ${after.headSha}); reading it again.`,
    );
  }

  throw new Error(
    'The pull request head kept changing while the diff was being read, so the review could not be bound to a commit.',
  );
}

async function main(): Promise<void> {
  const env = parseEnv();
  const { owner, repo } = splitRepository(env.GITHUB_REPOSITORY);
  const mode = env.REVIEW_MODE;

  // The commit the review is bound to. It is read live, and it is kept
  // here so that a failure after the read still reports the commit the
  // attempt was about.
  let headSha = env.PR_HEAD_SHA;

  try {
    const snapshot = await readHeadSnapshot(owner, repo, env.PR_NUMBER, env.GITHUB_TOKEN);
    headSha = snapshot.headSha;
    const { changedFiles } = snapshot;

    if (headSha !== env.PR_HEAD_SHA) {
      logLine(
        `The pull request head is now ${headSha}, not the ${env.PR_HEAD_SHA} the workflow was triggered for. The review refers to ${headSha}.`,
      );
    }

    const diff = buildReviewDiff(changedFiles, DIFF_BUDGET);

    logLine(
      `Reviewing PR #${env.PR_NUMBER} at ${headSha}: ${changedFiles.length} file(s), ${diff.length} character(s) of diff sent to the model.`,
    );

    const review = await reviewPullRequest({
      prTitle: env.PR_TITLE,
      prDescription: env.PR_DESCRIPTION,
      diff,
    });

    // The findings are sanitized once, here. The same list is given to the
    // gate and rendered into the body, so what the reviewer reads is
    // exactly what was decided on.
    const findings = sortFindingsBySeverity(sanitizeFindings(review.findings, changedFiles));

    const gate = decideGate({
      findings,
      changedFiles,
      mode,
      reviewCompleted: true,
    });

    logLine(
      `Model returned ${review.findings.length} finding(s); ${findings.length} survived sanitizing.`,
    );
    for (const finding of findings) {
      logLine(`  ${finding.severity}: ${finding.message}`);
    }
    logLine(`Gate outcome: ${gate}`);

    const event = reviewEventForGate(gate);
    const body = renderReviewBody({
      summary: review.summary,
      findings,
      reportedCount: review.findings.length,
      gate,
      commitSha: headSha,
    });

    // A COMMENT can be updated in place: only the body changes, and the
    // pull request keeps one authoritative review instead of a stack of
    // them. Anything else has to be a new review, because GitHub fixes a
    // review's event once it accepts it: a review that asked for changes
    // cannot be turned back into a comment by editing its body.
    // Read before posting, so the review about to be posted is never
    // among them.
    const superseded = await findSupersededReviews(env, owner, repo);

    let action: 'created' | 'updated';

    if (event === 'COMMENT') {
      action = await upsertReviewComment(owner, repo, env.PR_NUMBER, env.GITHUB_TOKEN, {
        commit_id: headSha,
        body,
      });
    } else {
      await submitReview(owner, repo, env.PR_NUMBER, env.GITHUB_TOKEN, {
        commit_id: headSha,
        body,
        event,
      });
      action = 'created';
    }

    logLine(`Posted one ${event} review on PR #${env.PR_NUMBER} (${action}).`);

    await dismissSuperseded(env, owner, repo, superseded, headSha);

    if (gateBlocksMerge(gate, mode)) {
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    // The review could not be completed. That is a fail-closed outcome,
    // and it has to be reported as an error on the pull request rather
    // than as a finding about the code: a broken agent must never look
    // like a defect in the pull request.
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`QA review failed: ${flattenText(reason)}\n`);

    await postFailureReview(env, owner, repo, reason, headSha);

    // The gate outcome is fail-closed. Whether that turns the check red
    // depends on the mode: in comment-only mode the agent is an observer
    // and nothing it does blocks a merge.
    if (gateBlocksMerge('fail-closed', mode)) {
      process.exitCode = 1;
    }
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
  commitSha: string,
): Promise<void> {
  try {
    const body = renderFailureBody(reason, commitSha, env.REVIEW_MODE);
    const superseded = await findSupersededReviews(env, owner, repo);

    const action = await upsertReviewComment(owner, repo, env.PR_NUMBER, env.GITHUB_TOKEN, {
      commit_id: commitSha,
      body,
    });

    logLine(`Posted one fail-closed review on PR #${env.PR_NUMBER} (${action}).`);

    await dismissSuperseded(env, owner, repo, superseded, commitSha);
  } catch (postError: unknown) {
    const message = postError instanceof Error ? postError.message : String(postError);
    process.stderr.write(`Could not post the fail-closed review: ${flattenText(message)}\n`);
  }
}

/**
 * Reads the agent's earlier requests for changes that are still in force.
 *
 * A request for changes stays in force until it is dismissed, whatever is
 * posted after it, so a pull request that was fixed would keep showing
 * "changes requested" from a verdict about an older commit. These are
 * read before the new review is posted and dismissed after it, so the
 * pull request is never left without a current verdict.
 *
 * Best effort: if they cannot be read, nothing is dismissed and the run
 * carries on. The required check, not the review, is the merge gate.
 */
async function findSupersededReviews(
  env: z.infer<typeof envSchema>,
  owner: string,
  repo: string,
): Promise<number[]> {
  try {
    return await findAgentChangeRequests(owner, repo, env.PR_NUMBER, env.GITHUB_TOKEN);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Could not read the earlier reviews, so none will be dismissed: ${flattenText(message)}\n`,
    );
    return [];
  }
}

/**
 * Dismisses the agent's earlier requests for changes.
 *
 * Runs only after the new review has been posted. Each dismissal is
 * attempted on its own, and a failure is logged rather than thrown: the
 * new verdict is already on the pull request.
 */
async function dismissSuperseded(
  env: z.infer<typeof envSchema>,
  owner: string,
  repo: string,
  reviewIds: readonly number[],
  commitSha: string,
): Promise<void> {
  for (const reviewId of reviewIds) {
    try {
      await dismissReview(
        owner,
        repo,
        env.PR_NUMBER,
        reviewId,
        env.GITHUB_TOKEN,
        `Superseded by the QA agent review of ${commitSha}.`,
      );
      logLine(`Dismissed the earlier request for changes (review ${reviewId}).`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Could not dismiss review ${reviewId}: ${flattenText(message)}\n`);
    }
  }
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`QA review failed: ${flattenText(reason)}\n`);
  process.exitCode = 1;
});

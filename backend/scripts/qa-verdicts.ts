/**
 * Renders the QA agent's finding verdicts for #59, from the verdict file
 * and the run data (#146).
 *
 * The verdicts live in `backend/qa/verdicts.json`, one row per finding the
 * agent posted, keyed by the finding id the review body and the stats line
 * both carry. The verdict and the note are kept by hand; everything else
 * comes from the runs. This script prints the Markdown table that replaces
 * the comment on #59, reconciled against the run data, so the comment is
 * a rendering rather than the source of truth.
 *
 * With --sync it first brings the file up to date: every finding id a run
 * logged gets a row, filled from the review the agent posted for that
 * commit, and the coverage and prompt version of each row are taken from
 * its run. Only reviews posted by the agent's own accounts, on the commit
 * their body names, are read, and only ids the stats line logged for the
 * same commit are accepted. The hand-kept columns are never changed. The
 * result is validated before it is written, and written atomically. Review
 * the diff before committing.
 *
 * Usage:
 *   pnpm --filter @six7swe/backend qa:verdicts            # render, reconciled with the runs
 *   pnpm --filter @six7swe/backend qa:verdicts --sync     # add new findings, then render
 *   pnpm --filter @six7swe/backend qa:verdicts --offline  # render from the file alone
 *   pnpm --filter @six7swe/backend qa:verdicts --check    # validate the file only
 *
 * Environment (not needed with --offline or --check):
 *   GITHUB_TOKEN or GH_TOKEN   required. The least it needs is a fine-grained
 *                              personal access token for this repository with
 *                              read-only "Actions" and read-only "Pull requests".
 *   GITHUB_REPOSITORY          optional, "owner/repo"; defaults to the `origin` remote
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  formatVerdictFile,
  parseAgentReview,
  parseVerdictFile,
  renderVerdictReport,
  syncVerdictFile,
  type PullRequestReview,
  type QaRunStats,
  type VerdictFile,
} from '../src/domain/qa';
import { AGENT_BOT_LOGINS } from '../src/services/github/prClient';
import { get, PER_PAGE, readJson, readRunData, repository, token } from './qa-runs';

const FILE_PATH = path.join(__dirname, '..', 'qa', 'verdicts.json');
const DISPLAY_PATH = 'backend/qa/verdicts.json';
const COMMAND = 'pnpm --filter @six7swe/backend qa:verdicts';

/** Past this, the report is close to GitHub's comment limit of 65,536 characters. */
const COMMENT_WARNING_CHARS = 60_000;

const MODES = ['--sync', '--offline', '--check'] as const;
type Mode = (typeof MODES)[number] | 'render';

function mode(args: readonly string[]): Mode {
  const unknown = args.filter((arg) => !MODES.some((known) => known === arg));
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(' ')}`);
  const picked = MODES.filter((known) => args.includes(known));
  if (picked.length > 1) throw new Error(`Pick one of ${MODES.join(', ')}`);
  return picked[0] ?? 'render';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validated(json: unknown, what: string): VerdictFile {
  const result = parseVerdictFile(json);
  if (!result.ok) throw new Error(`${what} is not valid:\n  ${result.errors.join('\n  ')}`);
  return result.file;
}

function readVerdictFile(): VerdictFile {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(FILE_PATH, 'utf-8'));
  } catch (error: unknown) {
    throw new Error(`Cannot read ${DISPLAY_PATH}: ${message(error)}`, { cause: error });
  }
  return validated(json, DISPLAY_PATH);
}

/**
 * Writes the file, but only once it validates, and atomically: a temporary
 * file renamed over the old one, so an interrupted run never leaves half a
 * file behind.
 */
function writeVerdictFile(file: VerdictFile): void {
  const checked = validated(file, `The synced ${DISPLAY_PATH}`);
  const temporary = `${FILE_PATH}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, formatVerdictFile(checked), 'utf-8');
    renameSync(temporary, FILE_PATH);
  } finally {
    // Gone after a successful rename; left behind only by a failed one.
    rmSync(temporary, { force: true });
  }
}

const reviewsSchema = z.array(
  z.looseObject({
    user: z.looseObject({ login: z.string() }).nullable(),
    body: z.string().nullable(),
    commit_id: z.string().nullable(),
  }),
);

/** The reviews the agent posted on a pull request, read back. */
async function agentReviews(repo: string, pr: number, auth: string): Promise<PullRequestReview[]> {
  const reviews: PullRequestReview[] = [];
  for (let page = 1; ; page += 1) {
    const apiPath = `/repos/${repo}/pulls/${pr}/reviews?per_page=${PER_PAGE}&page=${page}`;
    const batch = await readJson(await get(apiPath, auth), reviewsSchema, apiPath);
    for (const review of batch) {
      // Anyone can post a review that starts with the marker; only the
      // agent's own accounts post the agent's.
      if (!review.user || !AGENT_BOT_LOGINS.includes(review.user.login) || !review.body) continue;
      const parsed = parseAgentReview(review.body);
      // The review must be on the commit its body names.
      if (parsed && review.commit_id?.toLowerCase() === parsed.sha) reviews.push({ pr, ...parsed });
    }
    if (batch.length < PER_PAGE) break;
  }
  return reviews;
}

/** The pull requests with a logged id the file has no row for. */
function prsToSync(file: VerdictFile, runs: readonly QaRunStats[]): number[] {
  const known = new Set(file.findings.map((row) => row.findingId));
  const prs = new Set<number>();
  for (const run of runs) {
    if ((run.findingIds ?? []).some((id) => !known.has(id))) prs.add(run.pr);
  }
  return [...prs].sort((a, b) => a - b);
}

/** Merges the run data into the file and reports what changed; the caller writes it. */
async function sync(
  file: VerdictFile,
  runs: readonly QaRunStats[],
  repo: string,
  auth: string,
): Promise<VerdictFile> {
  const reviews: PullRequestReview[] = [];
  const unreadable = new Set<number>();
  for (const pr of prsToSync(file, runs)) {
    try {
      reviews.push(...(await agentReviews(repo, pr, auth)));
    } catch (error: unknown) {
      // One pull request that cannot be read (deleted, say) must not stop
      // the others; its findings are reported apart, below.
      unreadable.add(pr);
      process.stderr.write(`Could not read the reviews on #${pr}: ${message(error)}\n`);
    }
  }

  const result = syncVerdictFile(file, runs, reviews);

  process.stderr.write(
    `${DISPLAY_PATH}: ${result.added.length} row(s) added, ${result.updated.length} row(s) updated from their run.\n`,
  );
  const notRead = result.unrecoverable.filter((missing) => unreadable.has(missing.pr));
  for (const missing of notRead) {
    process.stderr.write(
      `  ${missing.findingId} (#${missing.pr} ${missing.sha.slice(0, 7)}): logged, but the reviews on its pull request could not be read; try again later.\n`,
    );
  }
  for (const missing of result.unrecoverable.filter((entry) => !unreadable.has(entry.pr))) {
    process.stderr.write(
      `  ${missing.findingId} (#${missing.pr} ${missing.sha.slice(0, 7)}): logged, but no review the agent posted shows it; it stays unadjudicated.\n`,
    );
  }
  for (const mismatch of result.mismatched) {
    process.stderr.write(
      `  ${mismatch.findingId}: the row says #${mismatch.row.pr} ${mismatch.row.sha.slice(0, 7)}, but the run that logged it is #${mismatch.run.pr} ${mismatch.run.sha.slice(0, 7)}; left unchanged.\n`,
    );
  }
  return result.file;
}

async function main(): Promise<void> {
  const selected = mode(process.argv.slice(2));
  let file = readVerdictFile();

  if (selected === '--check') {
    process.stderr.write(
      `${DISPLAY_PATH} is valid: ${file.findings.length} row(s) with an id, ${file.legacy.length} legacy.\n`,
    );
    return;
  }

  let runs: QaRunStats[] | null = null;
  if (selected !== '--offline') {
    const repo = repository();
    const auth = token();
    const data = await readRunData(repo, auth);
    runs = data.stats;
    if (data.runsWithExpiredLogs > 0) {
      process.stderr.write(
        `${data.runsWithExpiredLogs} run(s) could not be read: GitHub has deleted their logs.\n`,
      );
    }
    if (data.capped) {
      process.stderr.write(
        "GitHub's 1,000-result cap cut the run list short, so the oldest runs are missing.\n",
      );
    }
    if (selected === '--sync') {
      file = await sync(file, runs, repo, auth);
      writeVerdictFile(file);
    }
  }

  const report = renderVerdictReport(file, runs, { command: COMMAND, filePath: DISPLAY_PATH });
  if (report.length > COMMENT_WARNING_CHARS) {
    process.stderr.write(
      `The report is ${report.length.toLocaleString('en-US')} characters; a GitHub comment holds at most 65,536. Split it, for example the findings table into its own comment.\n`,
    );
  }
  process.stdout.write(report);
}

main().catch((error: unknown) => {
  process.stderr.write(`${message(error)}\n`);
  process.exitCode = 1;
});

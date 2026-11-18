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
 * its run. Only reviews posted by the workflow's own account are read, and
 * only ids the stats line logged for the same commit are accepted. The
 * hand-kept columns are never changed. Review the diff before committing.
 *
 * Usage:
 *   pnpm --filter @six7swe/backend qa:verdicts            # render, reconciled with the runs
 *   pnpm --filter @six7swe/backend qa:verdicts --sync     # add new findings, then render
 *   pnpm --filter @six7swe/backend qa:verdicts --offline  # render from the file alone
 *   pnpm --filter @six7swe/backend qa:verdicts --check    # validate the file only
 *
 * Environment (not needed with --offline or --check):
 *   GITHUB_TOKEN or GH_TOKEN   required, a token that can read the repository's Actions logs and pull requests
 *   GITHUB_REPOSITORY          optional, "owner/repo"; defaults to the `origin` remote
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
import { get, PER_PAGE, readRunData, repository, token } from './qa-runs';

const FILE_PATH = path.join(__dirname, '..', 'qa', 'verdicts.json');
const DISPLAY_PATH = 'backend/qa/verdicts.json';
const COMMAND = 'pnpm --filter @six7swe/backend qa:verdicts';

/** The account the workflow posts its reviews with (`GITHUB_TOKEN`). */
const AGENT_LOGIN = 'github-actions[bot]';

const MODES = ['--sync', '--offline', '--check'] as const;
type Mode = (typeof MODES)[number] | 'render';

function mode(args: readonly string[]): Mode {
  const unknown = args.filter((arg) => !MODES.some((known) => known === arg));
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(' ')}`);
  const picked = MODES.filter((known) => args.includes(known));
  if (picked.length > 1) throw new Error(`Pick one of ${MODES.join(', ')}`);
  return picked[0] ?? 'render';
}

function readVerdictFile(): VerdictFile {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(FILE_PATH, 'utf-8'));
  } catch (error: unknown) {
    throw new Error(
      `Cannot read ${DISPLAY_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const result = parseVerdictFile(json);
  if (!result.ok) {
    throw new Error(`${DISPLAY_PATH} is not valid:\n  ${result.errors.join('\n  ')}`);
  }
  return result.file;
}

interface Review {
  user: { login: string } | null;
  body: string | null;
}

/** The reviews the agent posted on a pull request, read back. */
async function agentReviews(repo: string, pr: number, auth: string): Promise<PullRequestReview[]> {
  const reviews: PullRequestReview[] = [];
  for (let page = 1; ; page += 1) {
    const response = await get(
      `/repos/${repo}/pulls/${pr}/reviews?per_page=${PER_PAGE}&page=${page}`,
      auth,
    );
    const batch = (await response.json()) as Review[];
    for (const review of batch) {
      // Anyone can post a review that starts with the marker; only the
      // workflow's own account posts the agent's.
      if (review.user?.login !== AGENT_LOGIN || !review.body) continue;
      const parsed = parseAgentReview(review.body);
      if (parsed) reviews.push({ pr, ...parsed });
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

async function sync(file: VerdictFile, runs: readonly QaRunStats[], repo: string, auth: string) {
  const reviews: PullRequestReview[] = [];
  for (const pr of prsToSync(file, runs)) {
    reviews.push(...(await agentReviews(repo, pr, auth)));
  }

  const result = syncVerdictFile(file, runs, reviews);
  writeFileSync(FILE_PATH, formatVerdictFile(result.file), 'utf-8');

  process.stderr.write(
    `${DISPLAY_PATH}: ${result.added.length} row(s) added, ${result.updated.length} row(s) updated from their run.\n`,
  );
  for (const missing of result.unrecoverable) {
    process.stderr.write(
      `  ${missing.findingId} (#${missing.pr} ${missing.sha.slice(0, 7)}): logged, but no review the agent posted shows it; it stays unadjudicated.\n`,
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
    if (selected === '--sync') file = await sync(file, runs, repo, auth);
  }

  process.stdout.write(
    renderVerdictReport(file, runs, { command: COMMAND, filePath: DISPLAY_PATH }),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

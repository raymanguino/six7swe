/**
 * Tallies the QA agent's runs into the phase 2 calibration table (#59).
 *
 * Reads every completed run of the QA Review workflow, pulls the one stats
 * line each run logs, and prints a Markdown table to paste into the issue.
 * Whether a finding was a real defect is a human judgement, so that part is
 * tracked by hand on the issue, not here.
 *
 * GitHub deletes workflow logs after 90 days by default, so a run older
 * than that can no longer be counted. The report says how many were lost.
 *
 * Usage:
 *   pnpm --filter @six7swe/backend qa:calibration
 *
 * Environment:
 *   GITHUB_TOKEN or GH_TOKEN   required, a token that can read the repository's Actions logs
 *   GITHUB_REPOSITORY          optional, "owner/repo"; defaults to the `origin` remote
 */

import { execFileSync } from 'node:child_process';
import {
  parseStatsLines,
  renderCalibrationReport,
  REVIEW_DIFF_BUDGET,
  summarizeCalibration,
  type QaRunStats,
} from '../src/domain/qa';

const API = 'https://api.github.com';
const WORKFLOW_FILE = 'qa-review.yml';
const JOB_NAME = 'QA agent review';
const PER_PAGE = 100;

class NotFound extends Error {}

function token(): string {
  const value = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!value) throw new Error('GITHUB_TOKEN or GH_TOKEN is required');
  return value;
}

/** The repository, from the environment or the `origin` remote. */
function repository(): string {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (fromEnv) return fromEnv;
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8' }).trim();
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error(`Cannot read owner/repo from the origin remote: ${remote}`);
  return match[1];
}

async function get(path: string, auth: string): Promise<Response> {
  // A job log answers with a redirect to a signed URL on another host.
  // fetch follows it and drops the Authorization header on the way, which
  // is what the signed URL expects.
  const response = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${auth}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status === 404 || response.status === 410) throw new NotFound(path);
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} ${response.statusText} for ${path}`);
  }
  return response;
}

interface WorkflowRun {
  id: number;
  created_at: string;
}

interface Job {
  id: number;
  name: string;
  conclusion: string | null;
}

async function listRuns(repo: string, auth: string): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  for (let page = 1; ; page += 1) {
    const response = await get(
      `/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?status=completed&per_page=${PER_PAGE}&page=${page}`,
      auth,
    );
    const body = (await response.json()) as { workflow_runs: WorkflowRun[] };
    runs.push(...body.workflow_runs);
    if (body.workflow_runs.length < PER_PAGE) break;
  }
  // Oldest first, so the summary keeps the latest run of a re-run commit.
  return runs.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

type RunLog = { kind: 'stats'; stats: QaRunStats[] } | { kind: 'none' } | { kind: 'expired' };

async function readRun(repo: string, runId: number, auth: string): Promise<RunLog> {
  const jobsResponse = await get(`/repos/${repo}/actions/runs/${runId}/jobs`, auth);
  const { jobs } = (await jobsResponse.json()) as { jobs: Job[] };
  const job = jobs.find((candidate) => candidate.name === JOB_NAME);
  if (!job || job.conclusion === 'skipped') return { kind: 'none' };

  try {
    const log = await (await get(`/repos/${repo}/actions/jobs/${job.id}/logs`, auth)).text();
    const stats = parseStatsLines(log);
    return stats.length > 0 ? { kind: 'stats', stats } : { kind: 'none' };
  } catch (error: unknown) {
    if (error instanceof NotFound) return { kind: 'expired' };
    throw error;
  }
}

async function main(): Promise<void> {
  const auth = token();
  const repo = repository();
  const runs = await listRuns(repo, auth);

  const stats: QaRunStats[] = [];
  let runsWithoutStats = 0;
  let runsWithExpiredLogs = 0;

  for (const run of runs) {
    const result = await readRun(repo, run.id, auth);
    if (result.kind === 'stats') stats.push(...result.stats);
    else if (result.kind === 'expired') runsWithExpiredLogs += 1;
    else runsWithoutStats += 1;
  }

  process.stdout.write(
    renderCalibrationReport(summarizeCalibration(stats), {
      runs: runs.length,
      runsWithoutStats,
      runsWithExpiredLogs,
      diffBudgetChars: REVIEW_DIFF_BUDGET.totalChars,
    }),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

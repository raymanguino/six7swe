/**
 * Reads the QA agent's run data from GitHub, for `qa:calibration` and
 * `qa:verdicts`.
 *
 * Every run of the QA Review workflow logs one stats line. This lists the
 * workflow's completed runs and reads that line back out of each job log.
 * GitHub deletes workflow logs after 90 days by default, so the result
 * says how many runs could not be read.
 *
 * Environment:
 *   GITHUB_TOKEN or GH_TOKEN   required. The least it needs is a fine-grained
 *                              personal access token for this repository with
 *                              read-only "Actions" (and read-only "Pull
 *                              requests" for `qa:verdicts --sync`).
 *   GITHUB_REPOSITORY          optional, "owner/repo"; defaults to the `origin` remote
 */

import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { parseStatsLines, type QaRunStats } from '../src/domain/qa';

const API = 'https://api.github.com';
const WORKFLOW_FILE = 'qa-review.yml';
const JOB_NAME = 'QA agent review';
export const PER_PAGE = 100;

export class NotFound extends Error {}

export function token(): string {
  const value = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!value) throw new Error('GITHUB_TOKEN or GH_TOKEN is required');
  return value;
}

/** What an "owner/repo" may look like; it goes into API paths. */
const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** A remote URL with any credentials in it masked, for an error message. */
function maskCredentials(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//***@');
}

/** The repository, from the environment or the `origin` remote. */
export function repository(): string {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (fromEnv) {
    if (!REPOSITORY_PATTERN.test(fromEnv)) {
      throw new Error('GITHUB_REPOSITORY must be in "owner/repo" form');
    }
    return fromEnv;
  }
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8' }).trim();
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (!match || !REPOSITORY_PATTERN.test(match[1])) {
    throw new Error(`Cannot read owner/repo from the origin remote: ${maskCredentials(remote)}`);
  }
  return match[1];
}

export async function get(path: string, auth: string): Promise<Response> {
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

/**
 * GitHub's list endpoints return at most this many results for a filtered
 * query, however many pages are asked for.
 */
const LIST_RESULT_CAP = 1000;

const workflowRunsSchema = z.looseObject({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(z.looseObject({ id: z.number().int(), created_at: z.string() })),
});

const jobsSchema = z.looseObject({
  jobs: z.array(
    z.looseObject({ id: z.number().int(), name: z.string(), conclusion: z.string().nullable() }),
  ),
});

/** Parses a GitHub response body, naming the endpoint when it has the wrong shape. */
export async function readJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  path: string,
): Promise<T> {
  const result = schema.safeParse(await response.json());
  if (!result.success) throw new Error(`GitHub answered ${path} with an unexpected shape`);
  return result.data;
}

type WorkflowRun = z.infer<typeof workflowRunsSchema>['workflow_runs'][number];

async function listRuns(
  repo: string,
  auth: string,
): Promise<{ runs: WorkflowRun[]; capped: boolean }> {
  const runs: WorkflowRun[] = [];
  for (let page = 1; ; page += 1) {
    // Only pull request runs post a review; the workflow has no other trigger
    // today, and the filter keeps it that way if one is added.
    const path = `/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?status=completed&event=pull_request&per_page=${PER_PAGE}&page=${page}`;
    const body = await readJson(await get(path, auth), workflowRunsSchema, path);
    runs.push(...body.workflow_runs);
    if (body.workflow_runs.length < PER_PAGE || runs.length >= LIST_RESULT_CAP) {
      // Oldest first, so the summary keeps the latest run of a re-run commit.
      runs.sort((a, b) => a.created_at.localeCompare(b.created_at));
      return { runs, capped: body.total_count > runs.length && runs.length >= LIST_RESULT_CAP };
    }
  }
}

type RunLog = { kind: 'stats'; stats: QaRunStats[] } | { kind: 'none' } | { kind: 'expired' };

async function readRun(repo: string, runId: number, auth: string): Promise<RunLog> {
  try {
    const path = `/repos/${repo}/actions/runs/${runId}/jobs`;
    const { jobs } = await readJson(await get(path, auth), jobsSchema, path);
    const job = jobs.find((candidate) => candidate.name === JOB_NAME);
    if (!job || job.conclusion === 'skipped') return { kind: 'none' };

    const log = await (await get(`/repos/${repo}/actions/jobs/${job.id}/logs`, auth)).text();
    const stats = parseStatsLines(log);
    return stats.length > 0 ? { kind: 'stats', stats } : { kind: 'none' };
  } catch (error: unknown) {
    if (error instanceof NotFound) return { kind: 'expired' };
    throw error;
  }
}

export interface RunData {
  /** The stats lines, oldest run first. */
  stats: QaRunStats[];
  /** Runs found, whatever they logged. */
  runs: number;
  /** Runs whose log had no stats line: they predate it, or the job never ran. */
  runsWithoutStats: number;
  /** Runs whose log GitHub no longer has. */
  runsWithExpiredLogs: number;
  /** True when GitHub's result cap cut the run list short: the oldest runs are missing. */
  capped: boolean;
}

/** Reads every completed run's stats line, oldest first. */
export async function readRunData(repo: string, auth: string): Promise<RunData> {
  const { runs, capped } = await listRuns(repo, auth);

  const stats: QaRunStats[] = [];
  let runsWithoutStats = 0;
  let runsWithExpiredLogs = 0;

  for (const run of runs) {
    const result = await readRun(repo, run.id, auth);
    if (result.kind === 'stats') stats.push(...result.stats);
    else if (result.kind === 'expired') runsWithExpiredLogs += 1;
    else runsWithoutStats += 1;
  }

  return { stats, runs: runs.length, runsWithoutStats, runsWithExpiredLogs, capped };
}

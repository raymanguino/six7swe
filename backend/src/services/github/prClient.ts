/**
 * GitHub REST client for pull request diffs and reviews.
 *
 * The only place in the system that talks to GitHub. It lives in `services/`
 * because it is a side effect; the review decision itself is pure and lives
 * in `backend/src/domain/qa/`.
 *
 * Native `fetch`, no dependency: `backend/src/services/mcpPortfolioClient.ts`
 * is the closest existing example of an outbound HTTP client in this repo.
 *
 * The token is only ever sent in the `Authorization` header. It is never
 * written into a URL, a log line or an error message.
 */

import { redactSecrets } from '../../util';
import type { ChangedFile, ReviewEvent } from '../../domain/qa';

export type { ChangedFile, ReviewEvent };

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';

/** GitHub's files endpoint returns at most 100 entries per page. */
const FILES_PER_PAGE = 100;

/** GitHub stops paginating the files endpoint at 3000 files. */
const MAX_FILE_PAGES = 30;

/** A GitHub API failure that carries the HTTP status. */
export class GitHubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export interface PullRequestSummary {
  title: string;
  body: string;
  headSha: string;
}

export interface ReviewSubmission {
  /** The pull request head SHA, so the review is not rendered as outdated. */
  commit_id: string;
  body: string;
  event: ReviewEvent;
}

interface GitHubPullRequestPayload {
  title?: string | null;
  body?: string | null;
  head?: { sha?: string | null } | null;
}

interface GitHubPullRequestFilePayload {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

async function githubFetch(
  url: string,
  token: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    Authorization: `Bearer ${token}`,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new GitHubApiError(
      `GitHub API error ${response.status} ${response.statusText} - ${redactSecrets(errorText)}`,
      response.status,
    );
  }

  return response;
}

function toChangedFile(file: GitHubPullRequestFilePayload): ChangedFile {
  const changed: ChangedFile = {
    filename: file.filename ?? '',
    status: file.status ?? 'modified',
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
  };

  // GitHub omits `patch` for binary files and for diffs that are too large
  // to render. An absent patch is not an error, it just means there is
  // nothing to show for that file.
  if (typeof file.patch === 'string') {
    changed.patch = file.patch;
  }

  return changed;
}

/**
 * Reads a pull request.
 *
 * GET /repos/{owner}/{repo}/pulls/{pullNumber}
 */
export async function getPullRequest(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
): Promise<PullRequestSummary> {
  const response = await githubFetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pullNumber}`,
    token,
  );
  const data = (await response.json()) as GitHubPullRequestPayload;

  const headSha = data.head?.sha ?? '';
  if (!headSha) {
    throw new Error('GitHub pull request payload is missing head.sha');
  }

  return {
    title: data.title ?? '',
    body: data.body ?? '',
    headSha,
  };
}

/**
 * Lists the files a pull request changed.
 *
 * GET /repos/{owner}/{repo}/pulls/{pullNumber}/files
 *
 * Paginates to the end. A pull request with more than 100 changed files
 * silently loses most of its diff otherwise.
 */
export async function listChangedFiles(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  let page = 1;

  while (page <= MAX_FILE_PAGES) {
    const response = await githubFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
      token,
    );
    const data = (await response.json()) as GitHubPullRequestFilePayload[];
    const batch = Array.isArray(data) ? data : [];

    files.push(...batch.map(toChangedFile));

    if (batch.length < FILES_PER_PAGE) {
      return files;
    }

    page += 1;
  }

  return files;
}

/**
 * Posts one review on a pull request.
 *
 * POST /repos/{owner}/{repo}/pulls/{pullNumber}/reviews
 *
 * The review event is final: it is posted once and never amended, so a run
 * produces exactly one review. `commit_id` must be the pull request head
 * SHA, otherwise GitHub renders the review as outdated against the current
 * diff.
 */
export async function submitReview(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
  review: ReviewSubmission,
): Promise<void> {
  await githubFetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
    token,
    { method: 'POST', body: review },
  );
}

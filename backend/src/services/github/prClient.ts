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

interface GitHubReviewPayload {
  id?: number;
  body?: string | null;
}

async function githubFetch(
  url: string,
  token: string,
  options: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown } = {},
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

/**
 * Hidden marker that identifies the agent's own review.
 *
 * It is an HTML comment, so GitHub renders nothing for it, and it is what
 * lets a later run find the review it posted before.
 */
export const REVIEW_MARKER = '<!-- six7swe-qa-agent -->';

/**
 * Lists the reviews on a pull request.
 *
 * GET /repos/{owner}/{repo}/pulls/{pullNumber}/reviews
 */
export async function listReviews(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
): Promise<GitHubReviewPayload[]> {
  const response = await githubFetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pullNumber}/reviews?per_page=${FILES_PER_PAGE}`,
    token,
  );
  const data = (await response.json()) as GitHubReviewPayload[];

  return Array.isArray(data) ? data : [];
}

/**
 * Replaces the body of an existing review.
 *
 * PATCH /repos/{owner}/{repo}/pulls/{pullNumber}/reviews/{reviewId}
 */
export async function updateReview(
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number,
  token: string,
  body: string,
): Promise<void> {
  await githubFetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pullNumber}/reviews/${reviewId}`,
    token,
    { method: 'PATCH', body: { body } },
  );
}

/**
 * Keeps a single, current review on a pull request.
 *
 * Every push to a pull request triggers a new review, and without this the
 * pull request accumulates a stack of them: the author cannot tell which is
 * current. This finds the agent's previous review by its hidden marker and
 * replaces its body, so there is exactly one authoritative review.
 *
 * Returns `updated` when an existing review was replaced and `created` when
 * a new one was posted.
 */
export async function upsertReviewComment(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
  review: { commit_id: string; body: string },
): Promise<'updated' | 'created'> {
  const reviews = await listReviews(owner, repo, pullNumber, token);

  const existing = [...reviews]
    .reverse()
    .find((candidate) => candidate.body?.includes(REVIEW_MARKER) && candidate.id !== undefined);

  if (existing?.id !== undefined) {
    await updateReview(owner, repo, pullNumber, existing.id, token, review.body);
    return 'updated';
  }

  await submitReview(owner, repo, pullNumber, token, {
    commit_id: review.commit_id,
    body: review.body,
    event: 'COMMENT',
  });

  return 'created';
}

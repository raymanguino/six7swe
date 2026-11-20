/**
 * GitHub REST client for pull request diffs and reviews.
 *
 * The only place in the system that talks to GitHub. It lives in `services/`
 * because it is a side effect; the review decision itself is pure and lives
 * in `backend/src/domain/qa/`.
 *
 * Native `fetch`, no dependency, like the knowledge service clients in
 * `backend/src/services/knowledge/`.
 *
 * The token is only ever sent in the `Authorization` header. It is never
 * written into a URL, a log line or an error message.
 */

import { redactSecrets } from '../../util';
import { REVIEW_MARKER, type ChangedFile, type ReviewEvent } from '../../domain/qa';

export type { ChangedFile, ReviewEvent };

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';

/** GitHub's files endpoint returns at most 100 entries per page. */
const FILES_PER_PAGE = 100;

/** GitHub stops paginating the files endpoint at 3000 files. */
const MAX_FILE_PAGES = 30;

/** GitHub's reviews endpoint returns at most 100 entries per page. */
const REVIEWS_PER_PAGE = 100;

/** How long a single request may take before it is aborted. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How many times a read is retried when GitHub is unavailable. */
const READ_RETRIES = 2;

/**
 * The bot accounts the agent posts as.
 *
 * The marker alone is not enough to identify the agent's own review: on a
 * public repository anyone can leave a review, so anyone can put the marker
 * in one. Matching the author as well means the agent only ever dismisses
 * a review it wrote itself.
 */
export const AGENT_BOT_LOGINS: readonly string[] = ['github-actions[bot]', 'six7swe-qa-agent[bot]'];

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
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

interface GitHubReviewPayload {
  id?: number;
  body?: string | null;
  user?: { login?: string } | null;
  /** `COMMENTED`, `CHANGES_REQUESTED`, `APPROVED`, `DISMISSED` or `PENDING`. */
  state?: string;
}

async function githubFetch(
  url: string,
  token: string,
  options: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    Authorization: `Bearer ${token}`,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const method = options.method ?? 'GET';
  const isRead = method === 'GET';

  const send = (): Promise<Response> =>
    fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  let response: Response;

  try {
    response = await send();

    // Only reads are retried. A write is not idempotent: retrying a POST
    // that actually succeeded but whose response was lost would post the
    // review twice, and the reviews endpoint explicitly warns about the
    // secondary rate limits that cause those failures.
    let attempt = 0;
    while (isRead && attempt < READ_RETRIES && isRetryableStatus(response.status)) {
      attempt += 1;
      await delay(attempt);
      response = await send();
    }
  } catch (error) {
    if (error instanceof GitHubApiError) {
      throw error;
    }
    throw new GitHubApiError(
      `GitHub API request failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      0,
    );
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new GitHubApiError(
      `GitHub API error ${response.status} ${response.statusText} - ${redactSecrets(errorText)}`,
      response.status,
    );
  }

  return response;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delay(attempt: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 500 * attempt);
  });
}

function toChangedFile(file: GitHubPullRequestFilePayload): ChangedFile {
  const changed: ChangedFile = {
    filename: file.filename ?? '',
    status: file.status ?? 'modified',
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
  };

  // GitHub reports a rename with the new path in `filename` and the old
  // one in `previous_filename`. Both matter: the path policy has to see
  // the file leaving a protected directory as well as arriving.
  if (typeof file.previous_filename === 'string') {
    changed.previousFilename = file.previous_filename;
  }

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
 *
 * GitHub stops serving this endpoint at 3000 files. Reaching that limit
 * throws instead of returning a partial list, because the path policy
 * reads this list: a truncated list could hide a protected file past the
 * cutoff.
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

  throw new GitHubApiError(
    `GitHub API error 422 - the pull request changes more than ${MAX_FILE_PAGES * FILES_PER_PAGE} files, which is the most the files endpoint returns`,
    422,
  );
}

/**
 * Posts one review on a pull request.
 *
 * POST /repos/{owner}/{repo}/pulls/{pullNumber}/reviews
 *
 * Every run posts a new review; none is ever edited. The review event is
 * final once GitHub accepts it. `commit_id` must be the pull
 * request head SHA, otherwise GitHub renders the review as outdated
 * against the current diff.
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
 * Dismisses a review.
 *
 * PUT /repos/{owner}/{repo}/pulls/{pullNumber}/reviews/{reviewId}/dismissals
 *
 * Only a review that approved or asked for changes can be dismissed; GitHub
 * refuses to dismiss a plain comment.
 */
export async function dismissReview(
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number,
  token: string,
  message: string,
): Promise<void> {
  await githubFetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pullNumber}/reviews/${reviewId}/dismissals`,
    token,
    { method: 'PUT', body: { message, event: 'DISMISS' } },
  );
}

/**
 * Hidden marker that identifies the agent's own review.
 *
 * It is what tells the agent's own reviews apart when the earlier ones are
 * read back, to find the requests for changes a new verdict supersedes.
 * It is defined in the domain module, next to the body renderer that
 * writes it, and re-exported here so the client and the body cannot
 * drift apart.
 */
export { REVIEW_MARKER };

/**
 * Lists the reviews on a pull request, oldest first.
 *
 * GET /repos/{owner}/{repo}/pulls/{pullNumber}/reviews
 */
export async function listReviews(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
): Promise<GitHubReviewPayload[]> {
  const reviews: GitHubReviewPayload[] = [];
  let page = 1;

  for (;;) {
    const response = await githubFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pullNumber}/reviews?per_page=${REVIEWS_PER_PAGE}&page=${page}`,
      token,
    );
    const data = (await response.json()) as GitHubReviewPayload[];
    const batch = Array.isArray(data) ? data : [];

    reviews.push(...batch);

    if (batch.length < REVIEWS_PER_PAGE) {
      return reviews;
    }

    page += 1;
  }
}

/**
 * Reports whether a review was written by the agent.
 *
 * The marker alone proves nothing: on a public repository anyone can
 * leave a review, so anyone can put the marker in one. The author has to
 * be one of the bot accounts as well. A `[bot]` login cannot be
 * registered by a person, so it is not spoofable.
 */
function isAgentReview(review: GitHubReviewPayload): boolean {
  const login = review.user?.login;

  return typeof login === 'string' && AGENT_BOT_LOGINS.includes(login);
}

/** The agent's own reviews, oldest first: written by the bot and carrying the marker. */
function agentReviews(reviews: readonly GitHubReviewPayload[]): GitHubReviewPayload[] {
  return reviews.filter(
    (review) =>
      review.id !== undefined &&
      review.body?.includes(REVIEW_MARKER) === true &&
      isAgentReview(review),
  );
}

/**
 * Finds the agent's requests for changes that are still in force.
 *
 * A later review does not clear an earlier request for changes from the
 * same reviewer: GitHub keeps it in force until it is dismissed. The script
 * reads these before it posts and dismisses them after, so that only the
 * latest verdict is ever live.
 *
 * Returns the review ids, oldest first.
 */
export async function findAgentChangeRequests(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
): Promise<number[]> {
  const reviews = await listReviews(owner, repo, pullNumber, token);

  return agentReviews(reviews)
    .filter((review) => review.state === 'CHANGES_REQUESTED')
    .map((review) => review.id as number);
}

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
 * in one. Matching the author as well means the agent only ever edits a
 * review it wrote itself.
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
 * The review event is final: once GitHub accepts it, only its body can
 * change, never its commit or its event. `commit_id` must be the pull
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
 * Hidden marker that identifies the agent's own review.
 *
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
 * Replaces the body of an existing review.
 *
 * PUT /repos/{owner}/{repo}/pulls/{pullNumber}/reviews/{reviewId}
 *
 * The route has no PATCH: GitHub answers a PATCH with 404.
 *
 * Only the body can be changed. The commit the review is attached to and
 * the event it carries stay as they were.
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
    { method: 'PUT', body: { body } },
  );
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

/**
 * Keeps a single, current review on a pull request.
 *
 * Every push to a pull request triggers a new review, and without this the
 * pull request accumulates a stack of them: the author cannot tell which is
 * current. This finds the agent's previous review by its hidden marker and
 * replaces its body, so there is exactly one authoritative review.
 *
 * The review stays attached to the commit it was first posted on, so
 * GitHub marks it as outdated after the next push. The body is what
 * carries the current verdict, and it names the commit it refers to. This
 * is why it is a Phase 1 mechanism: Phase 2 needs a review whose event
 * can change, and only a freshly posted review can do that.
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
    .find(
      (candidate) =>
        candidate.id !== undefined &&
        candidate.body?.includes(REVIEW_MARKER) === true &&
        isAgentReview(candidate),
    );

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

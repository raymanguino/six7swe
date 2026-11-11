import {
  AGENT_BOT_LOGINS,
  dismissReview,
  findAgentChangeRequests,
  getPullRequest,
  GitHubApiError,
  listChangedFiles,
  listReviews,
  REVIEW_MARKER,
  submitReview,
  updateReview,
  upsertReviewComment,
} from '../../services/github/prClient';

const TOKEN = 'ghp_testtoken0123456789abcdefghijklmnop';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function filePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filename: 'backend/src/index.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch: '@@ -1 +1 @@\n-old\n+new',
    ...overrides,
  };
}

describe('github pr client', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  describe('getPullRequest', () => {
    it('returns the title, body and head sha', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          title: 'feat(qa): something',
          body: 'A description.',
          head: { sha: 'abc123' },
        }),
      );

      const result = await getPullRequest('raymanguino', 'six7swe', 63, TOKEN);

      expect(result).toEqual({
        title: 'feat(qa): something',
        body: 'A description.',
        headSha: 'abc123',
      });
    });

    it('sends the expected headers and the token in the Authorization header', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ title: 't', body: 'b', head: { sha: 'abc123' } }),
      );

      await getPullRequest('raymanguino', 'six7swe', 63, TOKEN);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.github.com/repos/raymanguino/six7swe/pulls/63');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Accept).toBe('application/vnd.github+json');
      expect(headers['X-GitHub-Api-Version']).toBe('2026-03-10');
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('tolerates a null body', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ title: 't', body: null, head: { sha: 'abc123' } }),
      );

      const result = await getPullRequest('raymanguino', 'six7swe', 63, TOKEN);

      expect(result.body).toBe('');
    });

    it('fails when the payload carries no head sha', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ title: 't', body: 'b' }));

      await expect(getPullRequest('raymanguino', 'six7swe', 63, TOKEN)).rejects.toThrow(
        /head\.sha/,
      );
    });
  });

  describe('listChangedFiles', () => {
    it('returns the changed files', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([filePayload({ filename: 'a.ts' }), filePayload({ filename: 'b.ts' })]),
      );

      const files = await listChangedFiles('raymanguino', 'six7swe', 63, TOKEN);

      expect(files).toHaveLength(2);
      expect(files[0]).toEqual({
        filename: 'a.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-old\n+new',
      });
    });

    it('omits the patch when GitHub did not return one', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([filePayload({ patch: undefined })]));

      const files = await listChangedFiles('raymanguino', 'six7swe', 63, TOKEN);

      expect(files[0].patch).toBeUndefined();
    });

    it('follows pagination to the end', async () => {
      const fullPage = Array.from({ length: 100 }, (_, index) =>
        filePayload({ filename: `file-${index}.ts` }),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse(fullPage));
      fetchMock.mockResolvedValueOnce(jsonResponse([filePayload({ filename: 'last.ts' })]));

      const files = await listChangedFiles('raymanguino', 'six7swe', 63, TOKEN);

      expect(files).toHaveLength(101);
      expect(files[100].filename).toBe('last.ts');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain('page=2');
    });

    it('asks for 100 files per page', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([filePayload()]));

      await listChangedFiles('raymanguino', 'six7swe', 63, TOKEN);

      expect(fetchMock.mock.calls[0][0]).toContain('per_page=100');
    });

    it('returns an empty list when the pull request changed nothing', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      const files = await listChangedFiles('raymanguino', 'six7swe', 63, TOKEN);

      expect(files).toEqual([]);
    });

    it('carries the path a renamed file came from', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([filePayload({ filename: 'new.ts', previous_filename: 'old.ts' })]),
      );

      const files = await listChangedFiles('raymanguino', 'six7swe', 63, TOKEN);

      expect(files[0].previousFilename).toBe('old.ts');
    });

    it('fails rather than returning a truncated file list', async () => {
      const fullPage = Array.from({ length: 100 }, () => filePayload());
      for (let page = 0; page < 30; page += 1) {
        fetchMock.mockResolvedValueOnce(jsonResponse(fullPage));
      }

      await expect(listChangedFiles('raymanguino', 'six7swe', 63, TOKEN)).rejects.toBeInstanceOf(
        GitHubApiError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(30);
    });
  });

  describe('submitReview', () => {
    it('posts commit_id, body and event exactly once', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }, 200));

      await submitReview('raymanguino', 'six7swe', 63, TOKEN, {
        commit_id: 'abc123',
        body: '## QA agent review',
        event: 'COMMENT',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.github.com/repos/raymanguino/six7swe/pulls/63/reviews');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({
        commit_id: 'abc123',
        body: '## QA agent review',
        event: 'COMMENT',
      });
    });
  });

  describe('listReviews', () => {
    it('returns the reviews on the pull request', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          { id: 1, body: 'first' },
          { id: 2, body: 'second' },
        ]),
      );

      const reviews = await listReviews('raymanguino', 'six7swe', 63, TOKEN);

      expect(reviews).toHaveLength(2);
      expect(reviews[1].id).toBe(2);
    });

    it('follows pagination to the end', async () => {
      const fullPage = Array.from({ length: 100 }, (_, index) => ({ id: index, body: 'r' }));
      fetchMock.mockResolvedValueOnce(jsonResponse(fullPage));
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 100, body: 'last' }]));

      const reviews = await listReviews('raymanguino', 'six7swe', 63, TOKEN);

      expect(reviews).toHaveLength(101);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain('page=2');
    });
  });

  describe('updateReview', () => {
    it('replaces the review body with a PUT', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 7 }, 200));

      await updateReview('raymanguino', 'six7swe', 63, 7, TOKEN, 'new body');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.github.com/repos/raymanguino/six7swe/pulls/63/reviews/7');
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(init?.body as string)).toEqual({ body: 'new body' });
    });
  });

  describe('upsertReviewComment', () => {
    it('posts a new comment review when the agent has not reviewed yet', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 9 }, 200));

      const action = await upsertReviewComment('raymanguino', 'six7swe', 63, TOKEN, {
        commit_id: 'abc123',
        body: `${REVIEW_MARKER}\n## QA agent review`,
      });

      expect(action).toBe('created');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toBe('https://api.github.com/repos/raymanguino/six7swe/pulls/63/reviews');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({
        commit_id: 'abc123',
        body: `${REVIEW_MARKER}\n## QA agent review`,
        event: 'COMMENT',
      });
    });

    it('replaces the agent previous review instead of stacking a new one', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          { id: 1, body: 'a human review', user: { login: 'raymanguino' } },
          {
            id: 2,
            body: `${REVIEW_MARKER}\nold body`,
            user: { login: 'github-actions[bot]' },
            state: 'COMMENTED',
          },
        ]),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 2 }, 200));

      const action = await upsertReviewComment('raymanguino', 'six7swe', 63, TOKEN, {
        commit_id: 'abc123',
        body: `${REVIEW_MARKER}\nnew body`,
      });

      expect(action).toBe('updated');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toBe('https://api.github.com/repos/raymanguino/six7swe/pulls/63/reviews/2');
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(init?.body as string)).toEqual({
        body: `${REVIEW_MARKER}\nnew body`,
      });
    });

    it('updates the most recent agent review when there are several', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            id: 2,
            body: `${REVIEW_MARKER}\noldest`,
            user: { login: 'github-actions[bot]' },
            state: 'COMMENTED',
          },
          {
            id: 5,
            body: `${REVIEW_MARKER}\nnewest`,
            user: { login: 'github-actions[bot]' },
            state: 'COMMENTED',
          },
        ]),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 5 }, 200));

      const action = await upsertReviewComment('raymanguino', 'six7swe', 63, TOKEN, {
        commit_id: 'abc123',
        body: `${REVIEW_MARKER}\nfresh`,
      });

      expect(action).toBe('updated');
      expect(fetchMock.mock.calls[1][0]).toContain('/reviews/5');
    });

    it('ignores a review that carries the marker but was written by someone else', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          { id: 3, body: `${REVIEW_MARKER}\nspoofed`, user: { login: 'some-random-user' } },
        ]),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 9 }, 200));

      const action = await upsertReviewComment('raymanguino', 'six7swe', 63, TOKEN, {
        commit_id: 'abc123',
        body: `${REVIEW_MARKER}\nfresh`,
      });

      expect(action).toBe('created');
      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toBe('https://api.github.com/repos/raymanguino/six7swe/pulls/63/reviews');
      expect(init?.method).toBe('POST');
    });

    it('ignores a review with no author information at all', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 3, body: REVIEW_MARKER }]));
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 9 }, 200));

      const action = await upsertReviewComment('raymanguino', 'six7swe', 63, TOKEN, {
        commit_id: 'abc123',
        body: `${REVIEW_MARKER}\nfresh`,
      });

      expect(action).toBe('created');
    });

    it('recognises the app bot as the agent', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            id: 4,
            body: `${REVIEW_MARKER}\napp`,
            user: { login: AGENT_BOT_LOGINS[1] },
            state: 'COMMENTED',
          },
        ]),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 4 }, 200));

      const action = await upsertReviewComment('raymanguino', 'six7swe', 63, TOKEN, {
        commit_id: 'abc123',
        body: `${REVIEW_MARKER}\nfresh`,
      });

      expect(action).toBe('updated');
    });

    it('never edits a request for changes, because its event cannot change', async () => {
      // Editing it would put a passing verdict under a "changes requested"
      // event that GitHub keeps for good.
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            id: 6,
            body: `${REVIEW_MARKER}\nblocked`,
            user: { login: 'github-actions[bot]' },
            state: 'CHANGES_REQUESTED',
          },
        ]),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 9 }, 200));

      const action = await upsertReviewComment('raymanguino', 'six7swe', 63, TOKEN, {
        commit_id: 'abc123',
        body: `${REVIEW_MARKER}\nfresh`,
      });

      expect(action).toBe('created');
      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toBe('https://api.github.com/repos/raymanguino/six7swe/pulls/63/reviews');
      expect(init?.method).toBe('POST');
    });

    it('posts a new comment when the latest agent review is not a comment', async () => {
      // The older comment sits above the dismissed request in the timeline.
      // Editing it would hide the new verdict behind the old one.
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            id: 2,
            body: `${REVIEW_MARKER}\nfirst`,
            user: { login: 'github-actions[bot]' },
            state: 'COMMENTED',
          },
          {
            id: 6,
            body: `${REVIEW_MARKER}\nblocked`,
            user: { login: 'github-actions[bot]' },
            state: 'DISMISSED',
          },
        ]),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 9 }, 200));

      const action = await upsertReviewComment('raymanguino', 'six7swe', 63, TOKEN, {
        commit_id: 'abc123',
        body: `${REVIEW_MARKER}\nfresh`,
      });

      expect(action).toBe('created');
      expect(fetchMock.mock.calls[1][1]?.method).toBe('POST');
    });
  });

  describe('findAgentChangeRequests', () => {
    it('returns only the agent requests for changes that are still in force', async () => {
      const bot = { login: 'github-actions[bot]' };
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          { id: 1, body: `${REVIEW_MARKER}\nold`, user: bot, state: 'CHANGES_REQUESTED' },
          { id: 2, body: `${REVIEW_MARKER}\ncomment`, user: bot, state: 'COMMENTED' },
          { id: 3, body: `${REVIEW_MARKER}\ndismissed`, user: bot, state: 'DISMISSED' },
          { id: 4, body: 'a human', user: { login: 'raymanguino' }, state: 'CHANGES_REQUESTED' },
          {
            id: 5,
            body: `${REVIEW_MARKER}\nspoofed`,
            user: { login: 'some-random-user' },
            state: 'CHANGES_REQUESTED',
          },
          { id: 6, body: 'the bot, without the marker', user: bot, state: 'CHANGES_REQUESTED' },
          { id: 7, body: `${REVIEW_MARKER}\nnewer`, user: bot, state: 'CHANGES_REQUESTED' },
        ]),
      );

      const ids = await findAgentChangeRequests('raymanguino', 'six7swe', 63, TOKEN);

      expect(ids).toEqual([1, 7]);
    });
  });

  describe('dismissReview', () => {
    it('dismisses the review with a PUT to its dismissals', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 7, state: 'DISMISSED' }, 200));

      await dismissReview('raymanguino', 'six7swe', 63, 7, TOKEN, 'Superseded.');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://api.github.com/repos/raymanguino/six7swe/pulls/63/reviews/7/dismissals',
      );
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(init?.body as string)).toEqual({
        message: 'Superseded.',
        event: 'DISMISS',
      });
    });
  });

  describe('errors', () => {
    it('throws a GitHubApiError carrying the HTTP status and the body', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{"message":"Not Found"}', { status: 404 }));

      const error = await listChangedFiles('raymanguino', 'six7swe', 63, TOKEN).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(GitHubApiError);
      const apiError = error as GitHubApiError;
      expect(apiError.status).toBe(404);
      expect(apiError.message).toContain('Not Found');
    });

    it('never puts the token in the error message', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(`{"message":"bad token ${TOKEN}"}`, { status: 401 }),
      );

      const error = await listChangedFiles('raymanguino', 'six7swe', 63, TOKEN).catch(
        (caught: unknown) => caught,
      );

      expect((error as Error).message).not.toContain(TOKEN);
      expect((error as Error).message).toContain('[redacted]');
    });

    it('never puts the token in the URL', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      await listChangedFiles('raymanguino', 'six7swe', 63, TOKEN);

      expect(fetchMock.mock.calls[0][0]).not.toContain(TOKEN);
    });
  });
});

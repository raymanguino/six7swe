import { reviewPullRequest } from '../../services/ai/prReview';

/**
 * Exercises the whole real path: transport -> JSON parse -> Zod validation.
 * Only the HTTP call is stubbed.
 */
const VALID_RESPONSE = JSON.stringify({
  summary: 'The refresh path swallows a failure, so a broken profile looks healthy.',
  findings: [
    {
      severity: 'major',
      file: 'backend/src/services/jobHunt/jobRefreshService.ts',
      line: 194,
      message: 'The error is logged but the refresh row is never marked as failed.',
    },
    {
      severity: 'nit',
      file: null,
      line: null,
      message: 'Consider naming the retry count in the log message.',
    },
  ],
});

const INPUT = {
  prTitle: 'fix(jobhunt): mark a failed refresh',
  prDescription: 'The refresh row stays IN_PROGRESS when the fetch fails.',
  diff: '### backend/src/services/jobHunt/jobRefreshService.ts (modified) +2 -1\n-old\n+new',
};

describe('reviewPullRequest', () => {
  const originalKey = process.env.MINIMAX_API_KEY;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  function modelResponse(content: string): Response {
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
    });
  }

  function userMessage(): string {
    const body = JSON.parse((fetchMock.mock.calls[0][1]?.body as string) ?? '{}');
    return body.messages.find((message: { role: string }) => message.role === 'user').content;
  }

  beforeEach(() => {
    process.env.MINIMAX_API_KEY = 'test-key';
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    if (originalKey === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = originalKey;
  });

  it('returns the validated summary and findings', async () => {
    fetchMock.mockResolvedValueOnce(modelResponse(VALID_RESPONSE));

    const result = await reviewPullRequest(INPUT);

    expect(result.summary).toBe(
      'The refresh path swallows a failure, so a broken profile looks healthy.',
    );
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toEqual({
      severity: 'major',
      file: 'backend/src/services/jobHunt/jobRefreshService.ts',
      line: 194,
      message: 'The error is logged but the refresh row is never marked as failed.',
    });
  });

  it('falls back to the defaults when a finding omits the optional fields', async () => {
    fetchMock.mockResolvedValueOnce(
      modelResponse(
        JSON.stringify({
          summary: 'Nothing found.',
          findings: [{ severity: 'minor', message: 'A minor observation.' }],
        }),
      ),
    );

    const result = await reviewPullRequest(INPUT);

    expect(result.findings[0].file).toBeNull();
    expect(result.findings[0].line).toBeNull();
  });

  it('treats a missing findings array as no findings', async () => {
    fetchMock.mockResolvedValueOnce(modelResponse(JSON.stringify({ summary: 'Looks clean.' })));

    const result = await reviewPullRequest(INPUT);

    expect(result.findings).toEqual([]);
  });

  it('returns every finding, so a blocker past the eighth is never lost', async () => {
    const findings = Array.from({ length: 15 }, (_, index) => ({
      severity: 'nit',
      file: `backend/src/file-${index}.ts`,
      line: null,
      message: `Observation ${index}.`,
    }));
    findings[11] = {
      severity: 'blocker',
      file: 'backend/src/critical.ts',
      line: null,
      message: 'The one that matters.',
    };
    fetchMock.mockResolvedValueOnce(modelResponse(JSON.stringify({ summary: 'Many.', findings })));

    const result = await reviewPullRequest(INPUT);

    expect(result.findings).toHaveLength(15);
    expect(result.findings[11].severity).toBe('blocker');
  });

  it('rejects a malformed JSON response instead of returning fake findings', async () => {
    fetchMock.mockResolvedValueOnce(modelResponse('not json at all'));

    await expect(reviewPullRequest(INPUT)).rejects.toThrow();
  });

  it('rejects a response missing the summary', async () => {
    fetchMock.mockResolvedValueOnce(modelResponse(JSON.stringify({ findings: [] })));

    await expect(reviewPullRequest(INPUT)).rejects.toThrow();
  });

  it('rejects an unknown severity', async () => {
    fetchMock.mockResolvedValueOnce(
      modelResponse(
        JSON.stringify({
          summary: 'x',
          findings: [{ severity: 'critical', message: 'too bad' }],
        }),
      ),
    );

    await expect(reviewPullRequest(INPUT)).rejects.toThrow();
  });

  it('sends the pull request title, description and diff to the model', async () => {
    fetchMock.mockResolvedValueOnce(modelResponse(VALID_RESPONSE));

    await reviewPullRequest(INPUT);

    const message = userMessage();
    expect(message).toContain(INPUT.prTitle);
    expect(message).toContain(INPUT.prDescription);
    expect(message).toContain(INPUT.diff);
  });

  it('wraps the untrusted content in labelled delimiters', async () => {
    fetchMock.mockResolvedValueOnce(modelResponse(VALID_RESPONSE));

    await reviewPullRequest(INPUT);

    const message = userMessage();
    expect(message).toContain('<pull_request_title>');
    expect(message).toContain('</pull_request_title>');
    expect(message).toContain('<pull_request_description>');
    expect(message).toContain('</pull_request_description>');
    expect(message).toContain('<diff>');
    expect(message).toContain('</diff>');
  });

  it('puts the diff inside the diff delimiters', async () => {
    fetchMock.mockResolvedValueOnce(modelResponse(VALID_RESPONSE));

    await reviewPullRequest(INPUT);

    const message = userMessage();
    const diffBlock = message.slice(message.indexOf('<diff>'), message.indexOf('</diff>'));

    expect(diffBlock).toContain(INPUT.diff);
  });

  it('never asks for a temperature, which the model ignores', async () => {
    fetchMock.mockResolvedValueOnce(modelResponse(VALID_RESPONSE));

    await reviewPullRequest(INPUT);

    const body = JSON.parse((fetchMock.mock.calls[0][1]?.body as string) ?? '{}');
    expect(body.temperature).toBeUndefined();
    expect(body.max_completion_tokens).toBe(8192);
  });
});

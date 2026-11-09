import { matchJob } from '../../services/ai/jobMatch';

/**
 * Exercises the whole real path: transport -> JSON parse -> Zod validation
 * -> band derivation. Only the HTTP call is stubbed.
 */
const VALID_RESPONSE = JSON.stringify({
  score: 82,
  analysis: 'Strong overlap on backend and cloud work.',
  matchedSkills: ['Go', 'Kubernetes', 'CI/CD'],
  gaps: ['No experience with a specific ERP'],
  summary: 'A good match overall.',
});

const INPUT = {
  jobDescription: '- Title: Staff Engineer\n- Company: Example',
  profileContext: '- Skills: Go, Kubernetes',
};

describe('matchJob', () => {
  const originalKey = process.env.MINIMAX_API_KEY;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  function modelResponse(content: string): Response {
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
    });
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

  it('returns the validated match with a derived band', async () => {
    fetchMock.mockResolvedValueOnce(modelResponse(VALID_RESPONSE));

    const result = await matchJob(INPUT);

    expect(result.score).toBe(82);
    expect(result.band).toBe('HIGH');
    expect(result.analysis).toBe('Strong overlap on backend and cloud work.');
    expect(result.matchedSkills).toEqual(['Go', 'Kubernetes', 'CI/CD']);
    expect(result.gaps).toEqual(['No experience with a specific ERP']);
    expect(result.summary).toBe('A good match overall.');
  });

  it('derives the band from the score rather than trusting the model', async () => {
    const payload = { ...JSON.parse(VALID_RESPONSE), score: 50 };
    fetchMock.mockResolvedValueOnce(modelResponse(JSON.stringify(payload)));

    const result = await matchJob(INPUT);

    expect(result.score).toBe(50);
    expect(result.band).toBe('MEDIUM');
  });

  it('rejects a malformed JSON response instead of returning a fake score', async () => {
    fetchMock.mockResolvedValueOnce(modelResponse('not json at all'));

    await expect(matchJob(INPUT)).rejects.toThrow();
  });

  it('rejects a score outside the 0-100 range', async () => {
    const payload = { ...JSON.parse(VALID_RESPONSE), score: 150 };
    fetchMock.mockResolvedValueOnce(modelResponse(JSON.stringify(payload)));

    await expect(matchJob(INPUT)).rejects.toThrow();
  });

  it('rejects a response missing a required field', async () => {
    const { summary: _summary, ...withoutSummary } = JSON.parse(VALID_RESPONSE);
    fetchMock.mockResolvedValueOnce(modelResponse(JSON.stringify(withoutSummary)));

    await expect(matchJob(INPUT)).rejects.toThrow();
  });

  it('tolerates a response that omits the optional skill lists', async () => {
    const { matchedSkills: _m, gaps: _g, ...rest } = JSON.parse(VALID_RESPONSE);
    fetchMock.mockResolvedValueOnce(modelResponse(JSON.stringify(rest)));

    const result = await matchJob(INPUT);

    expect(result.matchedSkills).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it('accepts a response with more than five skills and trims the list', async () => {
    // Regression: the schema used to cap the arrays at five, so a model
    // response listing six gaps was rejected outright and the whole match
    // was lost.
    const payload = {
      ...JSON.parse(VALID_RESPONSE),
      matchedSkills: ['Go', 'Kubernetes', 'CI/CD', 'Postgres', 'gRPC', 'Kafka'],
      gaps: ['A', 'B', 'C', 'D', 'E', 'F'],
    };
    fetchMock.mockResolvedValueOnce(modelResponse(JSON.stringify(payload)));

    const result = await matchJob(INPUT);

    expect(result.matchedSkills).toHaveLength(5);
    expect(result.gaps).toHaveLength(5);
    expect(result.score).toBe(82);
  });

  it('rejects a response with an absurd number of skills', async () => {
    const payload = {
      ...JSON.parse(VALID_RESPONSE),
      matchedSkills: Array.from({ length: 21 }, (_, i) => `skill-${i}`),
    };
    fetchMock.mockResolvedValueOnce(modelResponse(JSON.stringify(payload)));

    await expect(matchJob(INPUT)).rejects.toThrow();
  });
});

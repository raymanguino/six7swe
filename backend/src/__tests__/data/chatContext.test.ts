import type { RetrievedChunkDto } from '@six7swe/knowledge-types';
import {
  buildRetrievalQuery,
  getFitcheckContext,
  getKnowledgeChatContext,
  recordFor,
  NO_MATCH_NOTE,
  UNAVAILABLE_NOTE,
  type KnowledgeChatContext,
} from '../../data/chatContext';
import type { RetrievalOutcome } from '../../domain/chatEval';
import { KnowledgeRetrievalError, type CachedRetriever } from '../../services/knowledgeRetrieval';

const chunk: RetrievedChunkDto = {
  chunkId: '00000000-0000-4000-8000-000000000001',
  documentId: '00000000-0000-4000-8000-000000000002',
  filename: 'resume.md',
  heading: 'Acme',
  content: 'Built the Kafka ingestion pipeline.',
  similarity: 0.9,
};

const retrieverReturning = (impl: CachedRetriever['retrieve']): CachedRetriever => ({
  retrieve: jest.fn(impl),
});

describe('getKnowledgeChatContext', () => {
  it('is the retrieved chunks', async () => {
    const retriever = retrieverReturning(async () => [chunk]);

    const result = await getKnowledgeChatContext({ message: 'Kafka?', retriever });

    expect(result.mode).toBe('retrieved');
    expect(result.chunkCount).toBe(1);
    expect(result.context).toContain('Relevant excerpts from my background documents');
    expect(result.context).toContain('[1] resume.md > Acme\nBuilt the Kafka ingestion pipeline.');
  });

  it('says the background is unavailable when retrieval fails, and logs it', async () => {
    const retriever = retrieverReturning(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const warn = jest.fn();

    const result = await getKnowledgeChatContext({
      message: 'Kafka?',
      retriever,
      log: { warn },
    });

    expect(result).toMatchObject({
      mode: 'no-background',
      reason: 'unavailable',
      chunkCount: 0,
      context: UNAVAILABLE_NOTE,
    });
    expect(warn).toHaveBeenCalledWith(
      { source: 'knowledge', error: { message: 'connect ECONNREFUSED' } },
      expect.stringContaining('Knowledge retrieval failed'),
    );
  });

  it('logs the status of a failed call, not the raw error', async () => {
    const warn = jest.fn();
    await getKnowledgeChatContext({
      message: 'Kafka?',
      retriever: retrieverReturning(async () => {
        throw new KnowledgeRetrievalError('Knowledge service /retrieve answered 503', {
          status: 503,
        });
      }),
      log: { warn },
    });
    expect(warn).toHaveBeenCalledWith(
      {
        source: 'knowledge',
        error: { message: 'Knowledge service /retrieve answered 503', status: 503 },
      },
      expect.any(String),
    );
  });

  it('says the background is unavailable when the service is not configured', async () => {
    const warn = jest.fn();
    const result = await getKnowledgeChatContext({
      message: 'Kafka?',
      retriever: null,
      log: { warn },
    });

    expect(result).toMatchObject({ mode: 'no-background', reason: 'unavailable' });
    expect(result.context).toBe(UNAVAILABLE_NOTE);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('says nothing matched when retrieval succeeds with no chunks', async () => {
    const warn = jest.fn();
    const result = await getKnowledgeChatContext({
      message: 'Kafka?',
      retriever: retrieverReturning(async () => []),
      log: { warn },
    });

    expect(result).toMatchObject({ mode: 'no-background', reason: 'no-match' });
    expect(result.context).toBe(NO_MATCH_NOTE);
    expect(warn).not.toHaveBeenCalled();
  });

  it('records a standalone question for the eval set, with the session', async () => {
    const retriever = retrieverReturning(async () => [chunk]);
    await getKnowledgeChatContext({ message: ' Kafka? ', retriever, sessionId: 'session-aaaa' });
    expect(retriever.retrieve).toHaveBeenCalledWith('Kafka?', {
      record: { sessionId: 'session-aaaa' },
    });
  });

  it('never records a follow-up (its query carries the previous turn) or a sessionless turn', async () => {
    const retriever = retrieverReturning(async () => [chunk]);
    await getKnowledgeChatContext({
      message: 'How long were you there?',
      history: [{ role: 'user', content: 'Tell me about Acme.' }],
      retriever,
      sessionId: 'session-aaaa',
    });
    await getKnowledgeChatContext({ message: 'Kafka?', retriever });
    expect(jest.mocked(retriever.retrieve).mock.calls).toEqual([
      ['Tell me about Acme.\nHow long were you there?'],
      ['Kafka?'],
    ]);
  });
});

describe('recordFor', () => {
  it('records only when the query is the current question alone', () => {
    expect(recordFor('Kafka?', { message: 'Kafka?', sessionId: 's-123456' })).toEqual({
      sessionId: 's-123456',
    });
    expect(
      recordFor('Earlier\nKafka?', { message: 'Kafka?', sessionId: 's-123456' }),
    ).toBeUndefined();
    expect(recordFor('Kafka?', { message: 'Kafka?' })).toBeUndefined();
  });
});

describe('buildRetrievalQuery', () => {
  it('adds the last user turn so a follow-up keeps its subject', () => {
    const query = buildRetrievalQuery('How long were you there?', [
      { role: 'user', content: 'Tell me about Acme' },
      { role: 'assistant', content: 'I was a senior engineer there.' },
    ]);
    expect(query).toBe('Tell me about Acme\nHow long were you there?');
  });

  it('is the question alone without history', () => {
    expect(buildRetrievalQuery('  Kafka?  ')).toBe('Kafka?');
    expect(buildRetrievalQuery('Kafka?', [{ role: 'user', content: 'Kafka?' }])).toBe('Kafka?');
  });

  it('stays inside the service query limit', () => {
    const long = 'x'.repeat(2000);
    expect(buildRetrievalQuery(long, [{ role: 'user', content: long }]).length).toBeLessThanOrEqual(
      2000,
    );
  });
});

describe('getFitcheckContext', () => {
  it('retrieves with the job description as the query, never recorded', async () => {
    const retriever = retrieverReturning(async () => [chunk]);
    const result = await getFitcheckContext({
      jobDescription: '  Senior engineer, Kafka and Postgres  ',
      retriever,
    });
    expect(retriever.retrieve).toHaveBeenCalledWith('Senior engineer, Kafka and Postgres');
    expect(result).toMatchObject({ mode: 'retrieved', chunkCount: 1 });
    expect(result.context).toContain('most relevant to this job');
    expect(result.context).toContain('[1] resume.md > Acme');
  });

  it('cuts a long posting to the service query limit', async () => {
    const retriever = retrieverReturning(async () => [chunk]);
    await getFitcheckContext({ jobDescription: 'x'.repeat(5000), retriever });
    expect(jest.mocked(retriever.retrieve).mock.calls[0]?.[0]).toHaveLength(2000);
  });

  it('reports an outage as unavailable, without throwing', async () => {
    const result = await getFitcheckContext({
      jobDescription: 'Engineer',
      retriever: retrieverReturning(async () => {
        throw new Error('down');
      }),
    });
    expect(result).toMatchObject({ mode: 'no-background', reason: 'unavailable' });
  });
});

describe('KnowledgeChatContext and the chat eval domain', () => {
  it('stays assignable to the eval domain RetrievalOutcome (compile-time check)', () => {
    const assignable = (context: KnowledgeChatContext): RetrievalOutcome => context;
    expect(assignable({ mode: 'retrieved', context: '', chunkCount: 1 }).mode).toBe('retrieved');
  });
});

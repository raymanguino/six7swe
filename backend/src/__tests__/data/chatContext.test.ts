import type { RetrievedChunkDto } from '@six7swe/knowledge-types';
import {
  buildProfileSummary,
  buildRetrievalQuery,
  getKnowledgeChatContext,
  type KnowledgeChatContext,
} from '../../data/chatContext';
import type { RetrievalOutcome } from '../../domain/chatEval';
import { getPortfolioData } from '../../services/portfolioService';
import { KnowledgeRetrievalError, type CachedRetriever } from '../../services/knowledgeRetrieval';
import type { PortfolioData } from '../../types/portfolio';

jest.mock('../../services/portfolioService', () => ({ getPortfolioData: jest.fn() }));
const mockedGetPortfolioData = jest.mocked(getPortfolioData);

const portfolio: PortfolioData = {
  profile: {
    id: 1,
    name: 'Ray Manguino',
    title: 'Software Engineer',
    email: 'ray@example.com',
    phone: null,
    location: 'Toronto',
    linkedinUrl: null,
    githubUrl: null,
    summary: 'Backend engineer focused on distributed systems.',
    skills: ['TypeScript', 'Postgres'],
    experience: [
      { title: 'Senior Engineer', company: 'Acme', period: '2021-2024', description: 'Long text' },
    ],
    projects: [],
    fullResumeText: 'FULL RESUME TEXT THAT MUST NOT BE STUFFED',
    resumeFilename: null,
  },
  contentSections: [{ id: 1, filename: 'hobbies', content: 'SECTION TEXT', sortOrder: 0 }],
};

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
  beforeEach(() => {
    mockedGetPortfolioData.mockResolvedValue(portfolio);
  });

  it('is the profile summary plus the retrieved chunks, not the stuffed resume', async () => {
    const retriever = retrieverReturning(async () => [chunk]);

    const result = await getKnowledgeChatContext({ message: 'Kafka?', retriever });

    expect(result.mode).toBe('retrieved');
    expect(result.chunkCount).toBe(1);
    expect(result.context).toContain('Name: Ray Manguino');
    expect(result.context).toContain('[1] resume.md > Acme\nBuilt the Kafka ingestion pipeline.');
    expect(result.context).not.toContain('FULL RESUME TEXT');
    expect(result.context).not.toContain('SECTION TEXT');
  });

  it('falls back to the profile only when retrieval fails, and logs it', async () => {
    const retriever = retrieverReturning(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const warn = jest.fn();

    const result = await getKnowledgeChatContext({
      message: 'Kafka?',
      retriever,
      log: { warn },
    });

    expect(result).toMatchObject({ mode: 'profile-only', reason: 'unavailable', chunkCount: 0 });
    expect(result.context).toContain('Profile summary:');
    expect(result.context).toContain('Skills: TypeScript, Postgres');
    expect(result.context).toContain('Detailed background documents are unavailable right now.');
    expect(result.context).not.toContain('Relevant excerpts');
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

  it('falls back to the profile only when the service is not configured', async () => {
    const warn = jest.fn();
    const result = await getKnowledgeChatContext({
      message: 'Kafka?',
      retriever: null,
      log: { warn },
    });

    expect(result).toMatchObject({ mode: 'profile-only', reason: 'unavailable' });
    expect(result.context).toContain('Detailed background documents are unavailable right now.');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('says nothing matched when retrieval succeeds with no chunks', async () => {
    const warn = jest.fn();
    const result = await getKnowledgeChatContext({
      message: 'Kafka?',
      retriever: retrieverReturning(async () => []),
      log: { warn },
    });

    expect(result).toMatchObject({ mode: 'profile-only', reason: 'no-match' });
    expect(result.context).toContain('No background documents matched this question.');
    expect(warn).not.toHaveBeenCalled();
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

describe('buildProfileSummary', () => {
  it('lists one line per role without descriptions', () => {
    const summary = buildProfileSummary(portfolio.profile);
    expect(summary).toContain('- Senior Engineer, Acme (2021-2024)');
    expect(summary).not.toContain('Long text');
  });

  it('handles a missing profile', () => {
    expect(buildProfileSummary(null)).toContain('(No profile data available.)');
  });
});

describe('KnowledgeChatContext and the chat eval domain', () => {
  it('stays assignable to the eval domain RetrievalOutcome (compile-time check)', () => {
    const assignable = (context: KnowledgeChatContext): RetrievalOutcome => context;
    expect(assignable({ mode: 'retrieved', context: '', chunkCount: 1 }).mode).toBe('retrieved');
  });
});

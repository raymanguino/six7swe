import { assertKnowledgeRetrievalConfigured } from '../../config/knowledgeRetrieval';

describe('assertKnowledgeRetrievalConfigured', () => {
  const production = (vars: Record<string, string>) => ({ NODE_ENV: 'production', ...vars });

  it('throws in production without the key', () => {
    expect(() =>
      assertKnowledgeRetrievalConfigured(production({ KNOWLEDGE_URL: 'http://knowledge:3100' })),
    ).toThrow(/KNOWLEDGE_SERVICE_KEY is required/);
  });

  it('throws in production on a missing or invalid URL without printing it', () => {
    expect(() =>
      assertKnowledgeRetrievalConfigured(production({ KNOWLEDGE_SERVICE_KEY: 'key' })),
    ).toThrow(/KNOWLEDGE_URL must be set/);
    const run = () =>
      assertKnowledgeRetrievalConfigured(
        production({
          KNOWLEDGE_SERVICE_KEY: 'key',
          KNOWLEDGE_URL: 'http://user:secret-pw@knowledge:3100',
        }),
      );
    expect(run).toThrow(/KNOWLEDGE_URL must be set/);
    expect(run).not.toThrow(/secret-pw/);
  });

  it('throws in production on a URL with a query or fragment', () => {
    for (const url of ['http://x:3100/b?x=1', 'http://x:3100/b#f', 'http://x:3100/b?']) {
      expect(() =>
        assertKnowledgeRetrievalConfigured(
          production({ KNOWLEDGE_SERVICE_KEY: 'key', KNOWLEDGE_URL: url }),
        ),
      ).toThrow(/valid http\(s\) URL without credentials, query or fragment/);
    }
  });

  it('passes in production when both are set', () => {
    expect(() =>
      assertKnowledgeRetrievalConfigured(
        production({ KNOWLEDGE_URL: 'http://knowledge:3100', KNOWLEDGE_SERVICE_KEY: 'key' }),
      ),
    ).not.toThrow();
  });

  it('leaves them optional outside production', () => {
    expect(() => assertKnowledgeRetrievalConfigured({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertKnowledgeRetrievalConfigured({})).not.toThrow();
  });
});

import { assertKnowledgeRetrievalConfigured } from '../../config/knowledgeRetrieval';

describe('assertKnowledgeRetrievalConfigured', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PORTFOLIO_DATA_SOURCE;
    delete process.env.KNOWLEDGE_URL;
    delete process.env.KNOWLEDGE_SERVICE_KEY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('throws when knowledge mode is on without the key', () => {
    process.env.PORTFOLIO_DATA_SOURCE = 'knowledge';
    process.env.KNOWLEDGE_URL = 'http://knowledge:3100';
    expect(() => assertKnowledgeRetrievalConfigured()).toThrow(/requires KNOWLEDGE_SERVICE_KEY/);
  });

  it('throws on a missing or invalid URL without printing it', () => {
    process.env.PORTFOLIO_DATA_SOURCE = 'knowledge';
    process.env.KNOWLEDGE_SERVICE_KEY = 'key';
    expect(() => assertKnowledgeRetrievalConfigured()).toThrow(/requires KNOWLEDGE_URL/);
    process.env.KNOWLEDGE_URL = 'http://user:secret-pw@knowledge:3100';
    const run = () => assertKnowledgeRetrievalConfigured();
    expect(run).toThrow(/requires KNOWLEDGE_URL/);
    expect(run).not.toThrow(/secret-pw/);
  });

  it('throws on a URL with a query or fragment', () => {
    process.env.PORTFOLIO_DATA_SOURCE = 'knowledge';
    process.env.KNOWLEDGE_SERVICE_KEY = 'key';
    for (const url of ['http://x:3100/b?x=1', 'http://x:3100/b#f', 'http://x:3100/b?']) {
      process.env.KNOWLEDGE_URL = url;
      expect(() => assertKnowledgeRetrievalConfigured()).toThrow(
        /valid http\(s\) URL without credentials, query or fragment/,
      );
    }
  });

  it('passes when both are set', () => {
    process.env.PORTFOLIO_DATA_SOURCE = 'knowledge';
    process.env.KNOWLEDGE_URL = 'http://knowledge:3100';
    process.env.KNOWLEDGE_SERVICE_KEY = 'key';
    expect(() => assertKnowledgeRetrievalConfigured()).not.toThrow();
  });

  it('ignores the variables in the other modes', () => {
    expect(() => assertKnowledgeRetrievalConfigured()).not.toThrow();
    process.env.PORTFOLIO_DATA_SOURCE = 'mcp';
    expect(() => assertKnowledgeRetrievalConfigured()).not.toThrow();
  });
});

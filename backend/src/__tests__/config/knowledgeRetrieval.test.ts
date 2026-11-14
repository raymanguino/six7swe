import { assertKnowledgeRetrievalConfigured } from '../../config/knowledgeRetrieval';

describe('assertKnowledgeRetrievalConfigured', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PORTFOLIO_DATA_SOURCE;
    delete process.env.KNOWLEDGE_SERVICE_URL;
    delete process.env.KNOWLEDGE_SERVICE_KEY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('throws when knowledge mode is on without the URL or key', () => {
    process.env.PORTFOLIO_DATA_SOURCE = 'knowledge';
    process.env.KNOWLEDGE_SERVICE_URL = 'http://knowledge:3100';
    expect(() => assertKnowledgeRetrievalConfigured()).toThrow(
      /requires KNOWLEDGE_SERVICE_URL and KNOWLEDGE_SERVICE_KEY/,
    );
  });

  it('passes when both are set', () => {
    process.env.PORTFOLIO_DATA_SOURCE = 'knowledge';
    process.env.KNOWLEDGE_SERVICE_URL = 'http://knowledge:3100';
    process.env.KNOWLEDGE_SERVICE_KEY = 'key';
    expect(() => assertKnowledgeRetrievalConfigured()).not.toThrow();
  });

  it('ignores the variables in the other modes', () => {
    expect(() => assertKnowledgeRetrievalConfigured()).not.toThrow();
    process.env.PORTFOLIO_DATA_SOURCE = 'mcp';
    expect(() => assertKnowledgeRetrievalConfigured()).not.toThrow();
  });
});

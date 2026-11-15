import { assertKnowledgeRetrievalConfigured } from '../../config/knowledgeRetrieval';

describe('assertKnowledgeRetrievalConfigured', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.KNOWLEDGE_URL;
    delete process.env.KNOWLEDGE_SERVICE_KEY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('throws without the key', () => {
    process.env.KNOWLEDGE_URL = 'http://knowledge:3100';
    expect(() => assertKnowledgeRetrievalConfigured()).toThrow(/KNOWLEDGE_SERVICE_KEY must be set/);
  });

  it('throws on a missing or invalid URL without printing it', () => {
    process.env.KNOWLEDGE_SERVICE_KEY = 'key';
    expect(() => assertKnowledgeRetrievalConfigured()).toThrow(
      /KNOWLEDGE_URL must be set to a valid/,
    );
    process.env.KNOWLEDGE_URL = 'http://user:secret-pw@knowledge:3100';
    const run = () => assertKnowledgeRetrievalConfigured();
    expect(run).toThrow(/KNOWLEDGE_URL must be set to a valid/);
    expect(run).not.toThrow(/secret-pw/);
  });

  it('throws on a URL with a query or fragment', () => {
    process.env.KNOWLEDGE_SERVICE_KEY = 'key';
    for (const url of ['http://x:3100/b?x=1', 'http://x:3100/b#f', 'http://x:3100/b?']) {
      process.env.KNOWLEDGE_URL = url;
      expect(() => assertKnowledgeRetrievalConfigured()).toThrow(
        /valid http\(s\) URL without credentials, query or fragment/,
      );
    }
  });

  it('passes when both are set', () => {
    process.env.KNOWLEDGE_URL = 'http://knowledge:3100';
    process.env.KNOWLEDGE_SERVICE_KEY = 'key';
    expect(() => assertKnowledgeRetrievalConfigured()).not.toThrow();
  });
});

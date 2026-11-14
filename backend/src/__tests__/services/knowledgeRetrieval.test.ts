import type { RetrieveResponse, RetrievedChunkDto } from '@six7swe/knowledge-types';
import { getKnowledgeRetrievalConfig } from '../../config/knowledgeRetrieval';
import {
  createCachedRetriever,
  createHttpRetrievalClient,
  KnowledgeRetrievalError,
  normalizeQuestion,
  type RetrievalClient,
} from '../../services/knowledgeRetrieval';

const chunk = (content: string): RetrievedChunkDto => ({
  chunkId: '00000000-0000-4000-8000-000000000001',
  documentId: '00000000-0000-4000-8000-000000000002',
  filename: 'resume.md',
  heading: 'Experience',
  content,
  similarity: 0.8,
});

function fakeClient(initialVersion = 1) {
  let version = initialVersion;
  const client = {
    getVersion: jest.fn(async () => version),
    retrieve: jest.fn(
      async (query: string): Promise<RetrieveResponse> => ({
        version,
        chunks: [chunk(`v${version}: ${query}`)],
      }),
    ),
  } satisfies RetrievalClient;
  return {
    client,
    setVersion: (v: number) => {
      version = v;
    },
  };
}

describe('normalizeQuestion', () => {
  it('ignores case, spacing and trailing punctuation', () => {
    expect(normalizeQuestion('  What  do you\tKNOW about Go?? ')).toBe('what do you know about go');
    expect(normalizeQuestion('what do you know about go')).toBe('what do you know about go');
  });
});

describe('createCachedRetriever', () => {
  let clock: number;
  const now = () => clock;
  const options = { k: 4, versionTtlMs: 1_000, failureCooldownMs: 5_000, maxEntries: 2, now };

  beforeEach(() => {
    clock = 0;
  });

  it('serves the same normalized question from the cache', async () => {
    const { client } = fakeClient();
    const retriever = createCachedRetriever(client, options);

    const first = await retriever.retrieve('Tell me about Kafka?');
    const second = await retriever.retrieve('tell me   about kafka');

    expect(second).toBe(first);
    expect(client.retrieve).toHaveBeenCalledTimes(1);
    expect(client.retrieve).toHaveBeenCalledWith('Tell me about Kafka?', 4);
  });

  it('misses once the corpus version changes', async () => {
    const { client, setVersion } = fakeClient(1);
    const retriever = createCachedRetriever(client, options);

    await retriever.retrieve('kafka');
    setVersion(2);
    // Still inside the version TTL: the old version is trusted.
    await retriever.retrieve('kafka');
    expect(client.retrieve).toHaveBeenCalledTimes(1);

    clock = 1_000;
    const fresh = await retriever.retrieve('kafka');
    expect(client.retrieve).toHaveBeenCalledTimes(2);
    expect(fresh[0]?.content).toBe('v2: kafka');
  });

  it('re-reads the version only after the TTL', async () => {
    const { client } = fakeClient();
    const retriever = createCachedRetriever(client, options);

    await retriever.retrieve('a');
    await retriever.retrieve('b');
    expect(client.getVersion).toHaveBeenCalledTimes(1);
    clock = 1_000;
    await retriever.retrieve('a');
    expect(client.getVersion).toHaveBeenCalledTimes(2);
  });

  it('files a result under the version it was computed against', async () => {
    const { client, setVersion } = fakeClient(1);
    const retriever = createCachedRetriever(client, options);
    // The version is read as 1, then the corpus moves to 3 before /retrieve.
    client.getVersion.mockResolvedValueOnce(1);
    setVersion(3);

    await retriever.retrieve('kafka');
    await retriever.retrieve('kafka');
    expect(client.retrieve).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used entry', async () => {
    const { client } = fakeClient();
    const retriever = createCachedRetriever(client, options);

    await retriever.retrieve('a');
    await retriever.retrieve('b');
    await retriever.retrieve('a'); // a is now the most recent
    await retriever.retrieve('c'); // evicts b
    expect(client.retrieve).toHaveBeenCalledTimes(3);

    await retriever.retrieve('a');
    expect(client.retrieve).toHaveBeenCalledTimes(3);
    await retriever.retrieve('b');
    expect(client.retrieve).toHaveBeenCalledTimes(4);
  });

  it('does not cache a failure', async () => {
    const { client } = fakeClient();
    client.retrieve.mockRejectedValueOnce(new KnowledgeRetrievalError('down'));
    const retriever = createCachedRetriever(client, options);

    await expect(retriever.retrieve('kafka')).rejects.toThrow('down');
    clock = 5_000;
    await expect(retriever.retrieve('kafka')).resolves.toHaveLength(1);
  });

  describe('after a failure', () => {
    it('fails fast for the cooldown, then tries the service again', async () => {
      const { client } = fakeClient();
      client.retrieve.mockRejectedValueOnce(new KnowledgeRetrievalError('timed out'));
      const retriever = createCachedRetriever(client, options);

      await expect(retriever.retrieve('kafka')).rejects.toThrow('timed out');
      clock = 4_999;
      await expect(retriever.retrieve('postgres')).rejects.toThrow('(cooling down): timed out');
      expect(client.retrieve).toHaveBeenCalledTimes(1);

      clock = 5_000;
      await expect(retriever.retrieve('postgres')).resolves.toHaveLength(1);
      expect(client.retrieve).toHaveBeenCalledTimes(2);
    });

    it('does not ask for the version again during the cooldown', async () => {
      const { client } = fakeClient();
      client.getVersion.mockRejectedValueOnce(new KnowledgeRetrievalError('unreachable'));
      const retriever = createCachedRetriever(client, options);

      await expect(retriever.retrieve('kafka')).rejects.toThrow('unreachable');
      await expect(retriever.retrieve('kafka')).rejects.toThrow(/cooling down/);
      expect(client.getVersion).toHaveBeenCalledTimes(1);
      expect(client.retrieve).not.toHaveBeenCalled();
    });

    it('still serves cached questions under the last known version', async () => {
      const { client } = fakeClient();
      const retriever = createCachedRetriever(client, options);
      const cached = await retriever.retrieve('kafka');

      clock = 1_000; // the version TTL has expired
      client.getVersion.mockRejectedValueOnce(new KnowledgeRetrievalError('unreachable'));
      await expect(retriever.retrieve('Kafka?')).resolves.toBe(cached);
      await expect(retriever.retrieve('postgres')).rejects.toThrow(/cooling down/);
      expect(client.retrieve).toHaveBeenCalledTimes(1);
    });
  });

  it('shares one in-flight version request between concurrent questions', async () => {
    const { client } = fakeClient();
    const retriever = createCachedRetriever(client, options);

    await Promise.all([retriever.retrieve('a'), retriever.retrieve('b'), retriever.retrieve('c')]);
    expect(client.getVersion).toHaveBeenCalledTimes(1);
  });

  it('follows /version down after a corpus reset and drops the old cache', async () => {
    const { client, setVersion } = fakeClient(40);
    const retriever = createCachedRetriever(client, options);
    const old = await retriever.retrieve('kafka');
    expect(old[0]?.content).toBe('v40: kafka');

    // The knowledge database is restored: the counter drops to 3.
    setVersion(3);
    clock = 1_000; // the version TTL has expired, so /version is polled
    const fresh = await retriever.retrieve('kafka');
    expect(fresh[0]?.content).toBe('v3: kafka');
    expect(client.retrieve).toHaveBeenCalledTimes(2);

    // New results are cached under 3.
    await expect(retriever.retrieve('Kafka?')).resolves.toBe(fresh);
    expect(client.retrieve).toHaveBeenCalledTimes(2);
  });

  it('drops entries cached under the lower version before a reset', async () => {
    const { client, setVersion } = fakeClient(3);
    const retriever = createCachedRetriever(client, options);
    await retriever.retrieve('kafka'); // cached under 3 from the old corpus
    setVersion(40);
    clock = 1_000;
    await retriever.retrieve('postgres');
    // Reset back to 3: the entry cached under 3 before must not be served.
    setVersion(3);
    clock = 2_000;
    const fresh = await retriever.retrieve('kafka');
    expect(client.retrieve).toHaveBeenCalledTimes(3);
    expect(fresh[0]?.content).toBe('v3: kafka');
  });

  it('never moves the known version backwards on a /retrieve response', async () => {
    const { client } = fakeClient(5);
    const retriever = createCachedRetriever(client, options);
    await retriever.retrieve('a');
    // A slow /retrieve answers with an older corpus version.
    client.retrieve.mockResolvedValueOnce({ version: 4, chunks: [chunk('old')] });
    await retriever.retrieve('b');

    // Still keyed by version 5, so 'a' is a hit.
    await retriever.retrieve('a');
    expect(client.retrieve).toHaveBeenCalledTimes(2);
  });
});

describe('createHttpRetrievalClient', () => {
  const config = { baseUrl: 'http://knowledge.test', serviceKey: 'service-key', timeoutMs: 1_000 };

  const respond = (status: number, body: unknown) =>
    jest.fn<Promise<Response>, Parameters<typeof fetch>>(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );

  it('posts the query with the service key and parses the response', async () => {
    const fetchFn = respond(200, { version: 7, chunks: [chunk('hello')] });
    const client = createHttpRetrievalClient(config, fetchFn);

    const result = await client.retrieve('kafka', 5);

    expect(result.version).toBe(7);
    expect(result.chunks[0]?.content).toBe('hello');
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('http://knowledge.test/retrieve');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ query: 'kafka', k: 5 }));
    expect((init?.headers as Record<string, string>)['x-knowledge-key']).toBe('service-key');
  });

  it('reads the corpus version', async () => {
    const client = createHttpRetrievalClient(config, respond(200, { version: 3 }));
    await expect(client.getVersion()).resolves.toBe(3);
  });

  it('rejects a non-2xx answer with its status', async () => {
    const client = createHttpRetrievalClient(config, respond(503, { error: 'down' }));
    const error: unknown = await client.retrieve('kafka', 5).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KnowledgeRetrievalError);
    expect((error as KnowledgeRetrievalError).status).toBe(503);
  });

  it('says when the service timed out', async () => {
    const fetchFn = jest.fn<Promise<Response>, Parameters<typeof fetch>>(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const client = createHttpRetrievalClient(config, fetchFn);
    await expect(client.getVersion()).rejects.toThrow('/version timed out after 1000 ms');
  });

  it('rejects a body that breaks the contract', async () => {
    const client = createHttpRetrievalClient(config, respond(200, { version: 'x', chunks: [] }));
    await expect(client.retrieve('kafka', 5)).rejects.toThrow(/did not match the contract/);
  });

  it('wraps a network failure', async () => {
    const fetchFn = jest.fn<Promise<Response>, Parameters<typeof fetch>>(async () => {
      throw new TypeError('fetch failed');
    });
    const client = createHttpRetrievalClient(config, fetchFn);
    await expect(client.getVersion()).rejects.toThrow(/unreachable/);
  });
});

describe('getKnowledgeRetrievalConfig', () => {
  it('is null without a URL and key', () => {
    expect(getKnowledgeRetrievalConfig({})).toBeNull();
    expect(getKnowledgeRetrievalConfig({ KNOWLEDGE_SERVICE_URL: 'http://x' })).toBeNull();
  });

  it('trims the trailing slash and clamps k to the contract maximum', () => {
    const config = getKnowledgeRetrievalConfig({
      KNOWLEDGE_SERVICE_URL: 'http://x:3100/',
      KNOWLEDGE_SERVICE_KEY: 'key',
      KNOWLEDGE_RETRIEVE_K: '99',
    });
    expect(config?.baseUrl).toBe('http://x:3100');
    expect(config?.k).toBe(20);
  });
});

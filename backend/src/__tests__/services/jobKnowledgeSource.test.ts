import { randomUUID } from 'node:crypto';
import {
  MAX_RETRIEVE_QUERY_CHARS,
  type DocumentDto,
  type RetrievedChunkDto,
} from '@six7swe/knowledge-types';
import {
  BACKGROUND_SUMMARY_K,
  BACKGROUND_SUMMARY_QUERY,
  createJobKnowledgeSource,
  JOB_MATCH_RETRIEVE_K,
  toRetrieveQuery,
} from '../../services/jobHunt/knowledgeSource';
import type { RetrievalClient } from '../../services/knowledgeRetrieval';

function doc(overrides: Partial<DocumentDto>): DocumentDto {
  return {
    id: randomUUID(),
    filename: 'resume.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
    kind: 'supporting',
    isPrimaryResume: false,
    status: 'ready',
    error: null,
    chunkCount: 3,
    findingCount: 0,
    scannedAt: null,
    approvedAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

const chunk = (content: string): RetrievedChunkDto => ({
  chunkId: randomUUID(),
  documentId: randomUUID(),
  filename: 'resume.md',
  heading: null,
  content,
  similarity: 0.8,
});

function retrievalClient(): jest.Mocked<RetrievalClient> {
  return {
    getVersion: jest.fn().mockResolvedValue(3),
    retrieve: jest.fn().mockResolvedValue({ version: 3, chunks: [] }),
  };
}

describe('job knowledge source', () => {
  it('cuts long job text to the service query limit', () => {
    const query = toRetrieveQuery(`  ${'x'.repeat(MAX_RETRIEVE_QUERY_CHARS + 50)}`);
    expect(query).toHaveLength(MAX_RETRIEVE_QUERY_CHARS);
  });

  it('retrieves with the job matching k', async () => {
    const retrieval = retrievalClient();
    const source = createJobKnowledgeSource({ retrieval, documents: null });
    await source.retrieve('Senior engineer');
    expect(retrieval.retrieve).toHaveBeenCalledWith('Senior engineer', JOB_MATCH_RETRIEVE_K);
  });

  it('retrieves the overall background with one fixed query', async () => {
    const retrieval = retrievalClient();
    const summary = [chunk('Staff engineer building platforms.')];
    retrieval.retrieve.mockResolvedValue({ version: 3, chunks: summary });
    const source = createJobKnowledgeSource({ retrieval, documents: null });

    await expect(source.getBackgroundSummary(3)).resolves.toEqual(summary);
    expect(retrieval.retrieve).toHaveBeenCalledWith(BACKGROUND_SUMMARY_QUERY, BACKGROUND_SUMMARY_K);
  });

  it('retrieves the overall background once per corpus version', async () => {
    const retrieval = retrievalClient();
    retrieval.retrieve
      .mockResolvedValueOnce({ version: 3, chunks: [chunk('old')] })
      .mockResolvedValueOnce({ version: 4, chunks: [chunk('new')] });
    const source = createJobKnowledgeSource({ retrieval, documents: null });

    const first = await source.getBackgroundSummary(3);
    // Every job and profile scored at version 3 shares it.
    await Promise.all([source.getBackgroundSummary(3), source.getBackgroundSummary(3)]);
    expect(retrieval.retrieve).toHaveBeenCalledTimes(1);

    // An upload moved the corpus: the next run reads version 4 and retrieves again.
    const second = await source.getBackgroundSummary(4);
    expect(retrieval.retrieve).toHaveBeenCalledTimes(2);
    expect(first[0]?.content).toBe('old');
    expect(second[0]?.content).toBe('new');
  });

  it('is empty when nothing matched, and throws when the service does not answer', async () => {
    const retrieval = retrievalClient();
    const source = createJobKnowledgeSource({ retrieval, documents: null });
    await expect(source.getBackgroundSummary(3)).resolves.toEqual([]);

    retrieval.retrieve.mockRejectedValueOnce(new Error('answered 503'));
    await expect(source.getBackgroundSummary(5)).rejects.toThrow('answered 503');
  });

  it('counts ready documents and reports the newest change', async () => {
    const source = createJobKnowledgeSource({
      retrieval: retrievalClient(),
      documents: {
        listDocuments: async () => [
          doc({ updatedAt: '2026-11-02T00:00:00.000Z' }),
          doc({ updatedAt: '2026-11-05T00:00:00.000Z' }),
          doc({ status: 'failed', updatedAt: '2026-11-09T00:00:00.000Z' }),
        ],
        getDocumentText: async () => null,
      },
    });
    await expect(source.getSummary()).resolves.toEqual({
      documentCount: 2,
      updatedAt: '2026-11-05T00:00:00.000Z',
    });
  });

  it('has no summary without the owner key', async () => {
    const source = createJobKnowledgeSource({ retrieval: retrievalClient(), documents: null });
    await expect(source.getSummary()).resolves.toBeNull();
  });
});

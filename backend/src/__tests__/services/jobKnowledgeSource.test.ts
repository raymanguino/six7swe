import { randomUUID } from 'node:crypto';
import { MAX_RETRIEVE_QUERY_CHARS, type DocumentDto } from '@six7swe/knowledge-types';
import {
  createJobKnowledgeSource,
  JOB_MATCH_RETRIEVE_K,
  toRetrieveQuery,
} from '../../services/jobHunt/knowledgeSource';
import type { RetrievalClient } from '../../services/knowledgeRetrieval';
import type { KnowledgeProfileClient } from '../../services/knowledge/profileClient';

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
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

const retrieval: jest.Mocked<RetrievalClient> = {
  getVersion: jest.fn().mockResolvedValue(3),
  retrieve: jest.fn().mockResolvedValue({ version: 3, chunks: [] }),
};

const noProfile: KnowledgeProfileClient = {
  getPublished: async () => ({ profile: null, resume: null }),
  getResumePdf: async () => null,
};

describe('job knowledge source', () => {
  it('cuts long job text to the service query limit', () => {
    const query = toRetrieveQuery(`  ${'x'.repeat(MAX_RETRIEVE_QUERY_CHARS + 50)}`);
    expect(query).toHaveLength(MAX_RETRIEVE_QUERY_CHARS);
  });

  it('retrieves with the job matching k', async () => {
    const source = createJobKnowledgeSource({ retrieval, profile: noProfile, documents: null });
    await source.retrieve('Senior engineer');
    expect(retrieval.retrieve).toHaveBeenCalledWith('Senior engineer', JOB_MATCH_RETRIEVE_K);
  });

  it('has no profile summary until one is published', async () => {
    const source = createJobKnowledgeSource({ retrieval, profile: noProfile, documents: null });
    await expect(source.getProfileSummary()).resolves.toBeNull();
  });

  it('summarizes the published profile', async () => {
    const profile: KnowledgeProfileClient = {
      getPublished: async () => ({
        profile: {
          stage: 'published',
          sourceDocumentId: null,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
          data: {
            name: 'Ray',
            title: 'Staff Engineer',
            location: null,
            summary: 'Builds platforms.',
            skills: ['TypeScript', 'Postgres'],
            experience: [],
            projects: [],
            links: { email: null, phone: null, linkedin: null, github: null, website: null },
          },
        },
        resume: null,
      }),
      getResumePdf: async () => null,
    };
    const source = createJobKnowledgeSource({ retrieval, profile, documents: null });
    await expect(source.getProfileSummary()).resolves.toBe(
      'Ray, Staff Engineer\nBuilds platforms.\nSkills: TypeScript, Postgres',
    );
  });

  it('counts ready documents and reports the newest change', async () => {
    const source = createJobKnowledgeSource({
      retrieval,
      profile: noProfile,
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
    const source = createJobKnowledgeSource({ retrieval, profile: noProfile, documents: null });
    await expect(source.getSummary()).resolves.toBeNull();
  });
});

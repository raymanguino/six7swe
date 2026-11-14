import { MAX_RETRIEVE_QUERY_CHARS, type RetrieveResponse } from '@six7swe/knowledge-types';
import { loadKnowledgeConfig } from '../../config/knowledge';
import { getKnowledgeRetrievalConfig } from '../../config/knowledgeRetrieval';
import type { KnowledgeDocumentSource } from '../../domain/chatEval';
import { createHttpRetrievalClient, type RetrievalClient } from '../knowledgeRetrieval';
import { createKnowledgeDocumentClient } from '../knowledge/documentsClient';
import {
  createKnowledgeProfileClient,
  type KnowledgeProfileClient,
} from '../knowledge/profileClient';

/**
 * The job hunter's view of the knowledge service: the owner's background that
 * every match is scored against.
 *
 * It is built from the existing knowledge clients (retrieval, published
 * profile, documents) rather than a client of its own. Retrieval goes
 * uncached: each job description is its own query, so a cache would only
 * ever miss.
 */

/** Chunks retrieved per job description. */
export const JOB_MATCH_RETRIEVE_K = 8;

/**
 * Job matching runs in the background, so it can wait longer than chat for a
 * slow service.
 */
const JOB_MATCH_TIMEOUT_MS = 10_000;

export interface KnowledgeSummary {
  /** Documents that are ingested and searchable. */
  documentCount: number;
  /** When the newest of them last changed; null when there are none. */
  updatedAt: string | null;
}

export interface JobKnowledgeSource {
  /** The current corpus version. Throws when the service does not answer. */
  getVersion(): Promise<number>;
  /** The chunks most relevant to a job description, and the version they came from. */
  retrieve(jobText: string): Promise<RetrieveResponse>;
  /**
   * The published profile rendered as a short summary, or null when the
   * owner has not published one.
   */
  getProfileSummary(): Promise<string | null>;
  /** Document count and freshness; null when the owner key is not configured. */
  getSummary(): Promise<KnowledgeSummary | null>;
}

/** Long postings are cut to the service's query limit; the opening says what the role is. */
export function toRetrieveQuery(jobText: string): string {
  return jobText.trim().slice(0, MAX_RETRIEVE_QUERY_CHARS);
}

export function createJobKnowledgeSource(clients: {
  retrieval: RetrievalClient;
  profile: KnowledgeProfileClient;
  documents: KnowledgeDocumentSource | null;
  k?: number;
}): JobKnowledgeSource {
  const k = clients.k ?? JOB_MATCH_RETRIEVE_K;

  return {
    getVersion: () => clients.retrieval.getVersion(),

    retrieve: (jobText) => clients.retrieval.retrieve(toRetrieveQuery(jobText), k),

    async getProfileSummary() {
      const { profile } = await clients.profile.getPublished();
      if (!profile) return null;
      const { data } = profile;
      const lines = [`${data.name}, ${data.title}`];
      if (data.summary) lines.push(data.summary);
      if (data.skills.length > 0) lines.push(`Skills: ${data.skills.join(', ')}`);
      return lines.join('\n');
    },

    async getSummary() {
      if (!clients.documents) return null;
      const ready = (await clients.documents.listDocuments()).filter(
        (doc) => doc.status === 'ready',
      );
      const updatedAt = ready.reduce<string | null>(
        (newest, doc) => (newest === null || doc.updatedAt > newest ? doc.updatedAt : newest),
        null,
      );
      return { documentCount: ready.length, updatedAt };
    },
  };
}

let defaultSource: JobKnowledgeSource | null | undefined;

/**
 * The process-wide source built from the environment, or null when
 * `KNOWLEDGE_URL` / `KNOWLEDGE_SERVICE_KEY` are not set. Matches are then
 * scored without background and are never called stale.
 */
export function getDefaultJobKnowledgeSource(): JobKnowledgeSource | null {
  if (defaultSource === undefined) {
    const config = getKnowledgeRetrievalConfig();
    if (!config) {
      defaultSource = null;
    } else {
      const timeoutMs = Math.max(config.timeoutMs, JOB_MATCH_TIMEOUT_MS);
      const owner = loadKnowledgeConfig().target;
      defaultSource = createJobKnowledgeSource({
        retrieval: createHttpRetrievalClient({ ...config, timeoutMs }),
        profile: createKnowledgeProfileClient({
          baseUrl: config.baseUrl,
          key: config.serviceKey,
          timeoutMs,
        }),
        documents: owner
          ? createKnowledgeDocumentClient({
              baseUrl: owner.url,
              ownerKey: owner.ownerKey,
              timeoutMs,
            })
          : null,
      });
    }
  }
  return defaultSource;
}

/** For tests: forget the source so the next call reads the environment again. */
export function resetDefaultJobKnowledgeSource(): void {
  defaultSource = undefined;
}

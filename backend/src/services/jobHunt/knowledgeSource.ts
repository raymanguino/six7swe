import type { RetrievedChunkDto, RetrieveResponse } from '@six7swe/knowledge-types';
import { loadKnowledgeConfig } from '../../config/knowledge';
import type { ProfileService } from '../../db/api/profile';
import { getKnowledgeRetrievalConfig } from '../../config/knowledgeRetrieval';
import type { KnowledgeDocumentSource } from '../../domain/chatEval';
import {
  createHttpRetrievalClient,
  toRetrieveQuery,
  type RetrievalClient,
} from '../knowledgeRetrieval';
import { createKnowledgeDocumentClient } from '../knowledge/documentsClient';
import { isKnowledgeOwner } from '../knowledge/ownerGate';
import { createVersionKeyedCache } from '../knowledge/versionKeyedCache';

/**
 * The job hunter's view of the knowledge service: the owner's background that
 * every match is scored against.
 *
 * It is built from the existing knowledge clients (retrieval, documents)
 * rather than a client of its own. Per-job retrieval goes uncached: each job
 * description is its own query, so a cache would only ever miss. The overall
 * background (one fixed query) is the same for every job, so it is cached by
 * corpus version.
 */

/** Chunks retrieved per job description. */
export const JOB_MATCH_RETRIEVE_K = 8;

/**
 * The one fixed retrieval for the candidate's overall background, sent with
 * every job: who they are, what they do now, and their core skills. Per-job
 * retrieval finds what a posting asks about; this keeps the basics in view
 * when a posting's wording matches none of them.
 */
export const BACKGROUND_SUMMARY_QUERY = 'Professional summary, current role and core skills';
/** Chunks in the overall background. */
export const BACKGROUND_SUMMARY_K = 4;

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
   * The overall background (`BACKGROUND_SUMMARY_QUERY`) at `version`, the
   * corpus version the caller just read. Cached by version: retrieved once
   * per corpus change, however many jobs and profiles are scored. Empty when
   * nothing matched; throws when the service does not answer.
   */
  getBackgroundSummary(version: number): Promise<readonly RetrievedChunkDto[]>;
  /** Document count and freshness; null when the owner key is not configured. */
  getSummary(): Promise<KnowledgeSummary | null>;
}

/** Long postings are cut to the service's query limit; the opening says what the role is. */
export { toRetrieveQuery };

export function createJobKnowledgeSource(clients: {
  retrieval: RetrievalClient;
  documents: KnowledgeDocumentSource | null;
  k?: number;
}): JobKnowledgeSource {
  const k = clients.k ?? JOB_MATCH_RETRIEVE_K;
  const backgroundSummary = createVersionKeyedCache(async () => {
    const { version, chunks } = await clients.retrieval.retrieve(
      BACKGROUND_SUMMARY_QUERY,
      BACKGROUND_SUMMARY_K,
    );
    return { version, value: chunks };
  });

  return {
    getVersion: () => clients.retrieval.getVersion(),

    retrieve: (jobText) => clients.retrieval.retrieve(toRetrieveQuery(jobText), k),

    getBackgroundSummary: (version) => backgroundSummary.get(version),

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

/**
 * The knowledge base is the owner's private background, so only the owner's
 * own profiles are scored against it. `source` is null when the service is
 * not configured; `ownerAuthId` is `OWNER_AUTH_ID` (null: nobody is the owner).
 */
export interface JobKnowledgeAccess {
  source: JobKnowledgeSource | null;
  ownerAuthId: string | null;
}

/**
 * The knowledge source for a profile whose user has this auth subject, or
 * null when that user is not the knowledge owner. Decided from the profile's
 * user row, not the request, so background and CLI runs are gated the same
 * way as requests.
 */
export function knowledgeForAuthId(
  access: JobKnowledgeAccess,
  authId: string | null,
): JobKnowledgeSource | null {
  if (!access.source) return null;
  // isKnowledgeOwner reads only the subject; the other fields are placeholders.
  const owner = isKnowledgeOwner(
    { id: 0, email: null, authId: authId ?? undefined },
    access.ownerAuthId,
  );
  return owner ? access.source : null;
}

/** {@link knowledgeForAuthId} for a profile, read from its user row. */
export async function knowledgeForProfile(
  access: JobKnowledgeAccess,
  profiles: Pick<ProfileService, 'getProfileOwnerAuthId'>,
  profileId: number,
): Promise<JobKnowledgeSource | null> {
  if (!access.source) return null;
  return knowledgeForAuthId(access, await profiles.getProfileOwnerAuthId(profileId));
}

/** The process-wide access built from the environment. */
export function getDefaultJobKnowledgeAccess(): JobKnowledgeAccess {
  return {
    source: getDefaultJobKnowledgeSource(),
    ownerAuthId: loadKnowledgeConfig().ownerAuthId,
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

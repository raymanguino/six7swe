import type {
  DocumentDto,
  EvalQuestionDto,
  EvalRunDto,
  RetrievedChunkDto,
  RetrieveResponse,
} from '../contract.js';
import type { EvalQuestionRecord, EvalRunWithResults } from '../db/api/evalRepository.js';
import { diffRuns } from '../services/evalSet/diff.js';
import type { DocumentRecord, RetrievedChunk } from '../db/api/repository.js';
import type { RetrievalResult } from '../services/retrieval.js';

/** Storage keys and owner ids are internal and never leave the service. */
export function toDocumentDto(doc: DocumentRecord): DocumentDto {
  return {
    id: doc.id,
    filename: doc.filename,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    kind: doc.kind,
    isPrimaryResume: doc.isPrimaryResume,
    status: doc.status,
    error: doc.error,
    chunkCount: doc.chunkCount,
    findingCount: doc.findingCount,
    scannedAt: doc.scannedAt?.toISOString() ?? null,
    approvedAt: doc.approvedAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toEvalQuestionDto(q: EvalQuestionRecord): EvalQuestionDto {
  return {
    id: q.id,
    question: q.question,
    status: q.status,
    origin: q.origin,
    pinned: q.pinned,
    offTopic: q.offTopic,
    hitCount: q.hitCount,
    distinctSessions: q.distinctSessions,
    exampleClicks: q.exampleClicks,
    lastAskedAt: q.lastAskedAt.toISOString(),
    createdAt: q.createdAt.toISOString(),
  };
}

const roundSimilarity = (n: number | null) => (n === null ? null : Math.round(n * 10_000) / 10_000);

/** A run with each result's diff against `previous` (the newest completed run at an older version). */
export function toEvalRunDto(
  run: EvalRunWithResults,
  previous: EvalRunWithResults | null,
): EvalRunDto {
  const { diffs, removed } = diffRuns(run.results, previous?.results ?? null);
  return {
    id: run.id,
    corpusVersion: run.corpusVersion,
    trigger: run.trigger,
    status: run.status,
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    previous: previous && { id: previous.id, corpusVersion: previous.corpusVersion },
    results: run.results.map((r, i) => ({
      questionId: r.questionId,
      question: r.question,
      answer: r.answer,
      chunkIds: r.chunkIds,
      topSimilarity: roundSimilarity(r.topSimilarity),
      gap: r.gap,
      diff: diffs[i] ?? null,
    })),
    removed: removed.map((r) => ({ questionId: r.questionId, question: r.question })),
  };
}

export function toChunkDto(chunk: RetrievedChunk): RetrievedChunkDto {
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    filename: chunk.filename,
    heading: chunk.heading,
    content: chunk.content,
    similarity: Math.round(chunk.similarity * 10_000) / 10_000,
  };
}

export const toRetrieveResponse = (result: RetrievalResult): RetrieveResponse => ({
  version: result.version,
  chunks: result.chunks.map(toChunkDto),
});

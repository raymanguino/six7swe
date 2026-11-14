import type { DocumentDto, PrimaryResumeDto, ProfileDto, RetrievedChunkDto } from '../contract.js';
import type { ProfileRecord } from '../db/api/profileRepository.js';
import { isPdf } from '../services/profile/profiles.js';
import type { DocumentRecord, RetrievedChunk } from '../db/api/repository.js';

export function toProfileDto(profile: ProfileRecord): ProfileDto {
  return {
    stage: profile.stage,
    data: profile.data,
    sourceDocumentId: profile.sourceDocumentId,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

export function toPrimaryResumeDto(doc: DocumentRecord, text: string | null): PrimaryResumeDto {
  return {
    documentId: doc.id,
    filename: doc.filename,
    mimeType: doc.mimeType,
    isPdf: isPdf(doc),
    text,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

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
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
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

/**
 * The knowledge service's wire types, as the backend's `/knowledge/*` proxy
 * relays them. They mirror `@six7swe/knowledge-types` (`packages/knowledge-types`),
 * the contract the backend and the service share.
 *
 * The frontend keeps its own copy on purpose: that package is Zod schemas
 * compiled to CommonJS `dist/` by a separate build step, and importing it would
 * make every frontend lint, dev and build depend on that step and pull Zod and
 * its server-side types into the browser bundle's graph. The page does not
 * trust these types anyway: the guards below check each response at runtime.
 * The contract has one owner, so when it changes, update this file with it.
 */

export type DocumentKind = 'resume' | 'supporting';

/** `needs_review`: the risk scan flagged it (#212); not searchable until approved. */
export type DocumentStatus = 'pending' | 'processing' | 'needs_review' | 'ready' | 'failed';

export interface KnowledgeDocument {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: DocumentKind;
  isPrimaryResume: boolean;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  /** How many findings the last risk scan stored. */
  findingCount: number;
  /** When the text was last risk-scanned; null when it has not been yet. */
  scannedAt: string | null;
  /** When the owner approved the current findings as they are; null otherwise. */
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RiskCategory =
  | 'contact_details'
  | 'home_address'
  | 'compensation'
  | 'reference_details'
  | 'confidential'
  | 'personal_details'
  | 'credentials'
  | 'negative_remarks'
  | 'other'
  | 'scan_failed';

export interface RiskFinding {
  category: RiskCategory;
  source: 'pattern' | 'model' | 'scan';
  excerpt: string;
  reason: string;
  location: { page: number | null; offset: number | null };
}

export interface DocumentFindingsResponse {
  document: KnowledgeDocument;
  findings: RiskFinding[];
}

/**
 * Whether the owner still has findings to review: a document held by the
 * scan, or a ready one the one-time backfill flagged and nobody approved yet.
 */
export const hasFindingsToReview = (doc: KnowledgeDocument): boolean =>
  doc.status === 'needs_review' ||
  (doc.status === 'ready' && doc.findingCount > 0 && doc.approvedAt === null);

export interface UploadResponse {
  document: KnowledgeDocument;
  deduplicated: boolean;
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  filename: string;
  heading: string | null;
  content: string;
  similarity: number;
}

export interface SearchResponse {
  version: number;
  chunks: RetrievedChunk[];
}

export interface DocumentTextResponse {
  documentId: string;
  text: string | null;
}

/** The file types the service ingests. */
export const ACCEPTED_EXTENSIONS = ['.pdf', '.md', '.txt'] as const;

export const isAcceptedFile = (file: File): boolean =>
  ACCEPTED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));

/** Matches the service's retrieve limits. */
export const MAX_SEARCH_K = 20;
export const DEFAULT_SEARCH_K = 6;

/*
 * Shallow guards for the responses. They check the shape the page relies on,
 * so a broken or unexpected response becomes a clear error instead of a
 * render crash; the full contract is the service's to enforce.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const STATUSES: readonly string[] = ['pending', 'processing', 'needs_review', 'ready', 'failed'];
const KINDS: readonly string[] = ['resume', 'supporting'];
const RISK_CATEGORIES: readonly string[] = [
  'contact_details',
  'home_address',
  'compensation',
  'reference_details',
  'confidential',
  'personal_details',
  'credentials',
  'negative_remarks',
  'other',
  'scan_failed',
];
const RISK_SOURCES: readonly string[] = ['pattern', 'model', 'scan'];

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const isNullableNumber = (value: unknown): value is number | null =>
  value === null || typeof value === 'number';

const isDocument = (value: unknown): value is KnowledgeDocument =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.filename === 'string' &&
  typeof value.sizeBytes === 'number' &&
  typeof value.chunkCount === 'number' &&
  typeof value.isPrimaryResume === 'boolean' &&
  typeof value.createdAt === 'string' &&
  typeof value.updatedAt === 'string' &&
  typeof value.kind === 'string' &&
  KINDS.includes(value.kind) &&
  typeof value.status === 'string' &&
  STATUSES.includes(value.status) &&
  isNullableString(value.error) &&
  typeof value.findingCount === 'number' &&
  isNullableString(value.scannedAt) &&
  isNullableString(value.approvedAt);

/**
 * The document, with the risk-scan fields defaulted when a service that
 * predates them leaves them out (as the contract's own defaults do); null
 * when it is not a document.
 */
function toDocument(value: unknown): KnowledgeDocument | null {
  if (!isRecord(value)) return null;
  const withDefaults = {
    ...value,
    findingCount: value.findingCount ?? 0,
    scannedAt: value.scannedAt ?? null,
    approvedAt: value.approvedAt ?? null,
  };
  return isDocument(withDefaults) ? withDefaults : null;
}

const isRiskFinding = (value: unknown): value is RiskFinding =>
  isRecord(value) &&
  typeof value.category === 'string' &&
  RISK_CATEGORIES.includes(value.category) &&
  typeof value.source === 'string' &&
  RISK_SOURCES.includes(value.source) &&
  typeof value.excerpt === 'string' &&
  typeof value.reason === 'string' &&
  isRecord(value.location) &&
  isNullableNumber(value.location.page) &&
  isNullableNumber(value.location.offset);

const isChunk = (value: unknown): value is RetrievedChunk =>
  isRecord(value) &&
  typeof value.chunkId === 'string' &&
  typeof value.filename === 'string' &&
  typeof value.content === 'string' &&
  typeof value.similarity === 'number' &&
  (value.heading === null || typeof value.heading === 'string');

function invalid(what: string): never {
  throw new Error(`Unexpected ${what} response from the server`);
}

export function parseDocumentList(data: unknown): KnowledgeDocument[] {
  if (!isRecord(data) || !Array.isArray(data.documents)) return invalid('document list');
  const documents: KnowledgeDocument[] = [];
  for (const raw of data.documents) {
    const document = toDocument(raw);
    if (!document) return invalid('document list');
    documents.push(document);
  }
  return documents;
}

/** `GET /knowledge/documents/:id`, `PUT .../primary` and `POST .../approve`. */
export function parseDocument(data: unknown): KnowledgeDocument {
  const document = isRecord(data) ? toDocument(data.document) : null;
  return document ?? invalid('document');
}

export function parseUpload(data: unknown): UploadResponse {
  const document = isRecord(data) ? toDocument(data.document) : null;
  if (!isRecord(data) || !document || typeof data.deduplicated !== 'boolean') {
    return invalid('upload');
  }
  return { document, deduplicated: data.deduplicated };
}

/** `GET /knowledge/documents/:id/findings`. */
export function parseFindings(data: unknown): DocumentFindingsResponse {
  const document = isRecord(data) ? toDocument(data.document) : null;
  if (
    !isRecord(data) ||
    !document ||
    !Array.isArray(data.findings) ||
    !data.findings.every(isRiskFinding)
  ) {
    return invalid('findings');
  }
  return { document, findings: data.findings };
}

export function parseText(data: unknown): DocumentTextResponse {
  if (
    !isRecord(data) ||
    typeof data.documentId !== 'string' ||
    !(data.text === null || typeof data.text === 'string')
  ) {
    return invalid('text');
  }
  return { documentId: data.documentId, text: data.text };
}

export function parseSearch(data: unknown): SearchResponse {
  if (
    !isRecord(data) ||
    typeof data.version !== 'number' ||
    !Array.isArray(data.chunks) ||
    !data.chunks.every(isChunk)
  ) {
    return invalid('search');
  }
  return { version: data.version, chunks: data.chunks };
}

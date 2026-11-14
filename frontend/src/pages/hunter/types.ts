/** Shared types for the job-hunter UI, mirroring the API responses. */

export type MatchBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'TOP';

export type RefreshStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export type RefreshStep = 'PENDING' | 'FETCHING_JOBS' | 'FILTERING_JOBS';

export interface SearchProfile {
  id: number;
  userId: number;
  name: string;
  keywords: string[];
  location: string | null;
  additionalContext: string | null;
}

export interface ProfileJob {
  id: number;
  profileId: number;
  jobId: number;
  jobHash: string;
  score: number | null;
  band: MatchBand | null;
  explanation: string | null;
  firstSkillMatch: string | null;
  secondSkillMatch: string | null;
  thirdSkillMatch: string | null;
  summary: string | null;
  /** The knowledge corpus version the match was scored against; null when none was used. */
  knowledgeVersion: number | null;
  /** The knowledge documents retrieved as background for the match. */
  evidence: MatchEvidence[];
  /** Scored against an older version of the knowledge base than the current one. */
  stale: boolean;
}

export interface MatchEvidence {
  documentId: string;
  filename: string;
}

/** `GET /job-hunt/profiles/:id/jobs`: where the knowledge base stands for these matches. */
export interface MatchKnowledgeState {
  configured: boolean;
  /** The current corpus version; null when unknown. */
  version: number | null;
  staleCount: number;
}

/** `GET /job-hunt/knowledge`: what matches are scored against. */
export interface KnowledgeStatus {
  configured: boolean;
  version: number | null;
  /** Ready documents; null when the backend cannot list them. */
  documentCount: number | null;
  /** When the newest ready document last changed. */
  updatedAt: string | null;
}

export interface Job {
  id: number;
  sourceId: string;
  sourceJobId: string;
  link: string;
  company: string;
  position: string;
  description: string;
  location: string | null;
  datePosted: string | null;
}

export interface RefreshStatusRow {
  id: number;
  profileId: number;
  status: RefreshStatus;
  step: RefreshStep;
  description: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

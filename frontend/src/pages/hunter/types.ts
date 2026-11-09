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
  resume: string | null;
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

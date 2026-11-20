import type { RetrievedChunkDto } from '@six7swe/knowledge-types';
import type { Job, MatchEvidence, Profile } from '../../db/schema/jobHunt';

/**
 * Builds the candidate context handed to the canonical matcher.
 *
 * The matcher is profile-source agnostic: it accepts a context string and
 * knows nothing about where it came from. Here it is the search profile's own
 * fields, the owner's overall background (one fixed retrieval), and the
 * knowledge chunks retrieved with the job description as the query.
 */

/**
 * Text a user typed or a job board served is data, never instructions. It is
 * fenced in these tags, and the matcher's system prompt says so
 * (`services/ai/prompts/jobMatch.ts`).
 */
export const PROFILE_NOTES_TAG = 'profile_notes';
export const JOB_POSTING_TAG = 'job_posting';
export const BACKGROUND_TAG = 'background';

/**
 * Wraps untrusted text in `<tag>` ... `</tag>`. A tag of the same name inside
 * the text is defused first (`<` becomes `[`), so the text cannot close the
 * fence early and carry on as if it were outside it.
 */
export function untrusted(tag: string, text: string): string {
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200F\u2060\uFEFF]/g, '');
  const defused = normalized.replace(new RegExp(`<(\\s*/?\\s*${tag})`, 'gi'), '[$1');
  return `<${tag}>\n${defused}\n</${tag}>`;
}

export interface CandidateBackground {
  /**
   * The overall background: summary, current role and skills
   * (`BACKGROUND_SUMMARY_QUERY`). Empty when it could not be read.
   */
  summary: readonly RetrievedChunkDto[];
  /** Chunks retrieved for this job, most relevant first. */
  chunks: readonly RetrievedChunkDto[];
}

function renderChunks(chunks: readonly RetrievedChunkDto[], lines: string[]): void {
  chunks.forEach((chunk, index) => {
    const heading = chunk.heading ? ` - ${chunk.heading}` : '';
    lines.push(`[${index + 1}] ${chunk.filename}${heading}`, chunk.content.trim(), '');
  });
}

export function buildSearchProfileContext(
  profile: Pick<Profile, 'keywords' | 'location' | 'additionalContext'>,
  background: CandidateBackground = { summary: [], chunks: [] },
): string {
  const lines = [
    `- Keywords: ${(profile.keywords ?? []).join(', ') || 'Not specified'}`,
    `- Location: ${profile.location ?? 'Not specified'}`,
  ];

  if (profile.additionalContext) {
    lines.push('- Additional Context:', untrusted(PROFILE_NOTES_TAG, profile.additionalContext));
  }

  const backgroundLines: string[] = [];
  // A summary chunk the job retrieval also found is shown once, with the job's.
  const jobChunkIds = new Set(background.chunks.map((chunk) => chunk.chunkId));
  const summary = background.summary.filter((chunk) => !jobChunkIds.has(chunk.chunkId));
  if (summary.length > 0) {
    backgroundLines.push('Overview of the candidate (summary, current role and skills):');
    renderChunks(summary, backgroundLines);
  }
  backgroundLines.push("Excerpts from the candidate's documents, most relevant first:");
  if (background.chunks.length === 0) {
    backgroundLines.push('No background documents are available.');
  } else {
    renderChunks(background.chunks, backgroundLines);
  }

  lines.push('', 'Background:', untrusted(BACKGROUND_TAG, backgroundLines.join('\n').trimEnd()));

  return lines.join('\n').trimEnd();
}

/** The distinct documents behind the retrieved chunks, in order of relevance. */
export function evidenceFromChunks(chunks: readonly RetrievedChunkDto[]): MatchEvidence[] {
  const seen = new Set<string>();
  const evidence: MatchEvidence[] = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.documentId)) continue;
    seen.add(chunk.documentId);
    evidence.push({ documentId: chunk.documentId, filename: chunk.filename });
  }
  return evidence;
}

/** The job fields the matcher reads. */
export type JobForMatching = Pick<
  Job,
  'position' | 'company' | 'location' | 'description' | 'link'
>;

/**
 * Renders a stored job row as the description text the matcher reads. Every
 * field is scraped from the posting, so the whole block is untrusted data.
 */
export function buildJobDescription(job: JobForMatching): string {
  return untrusted(
    JOB_POSTING_TAG,
    [
      `- Title: ${job.position}`,
      `- Company: ${job.company}`,
      `- Location: ${job.location ?? 'Not specified'}`,
      `- Description: ${job.description || 'No description provided'}`,
      `- Link: ${job.link}`,
    ].join('\n'),
  );
}

/** The text used to retrieve background for a job: what the role is and asks for. */
export function buildJobRetrievalQuery(job: Pick<Job, 'position' | 'description'>): string {
  return `${job.position}\n${job.description}`;
}

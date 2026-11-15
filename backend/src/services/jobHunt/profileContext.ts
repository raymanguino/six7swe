import type { RetrievedChunkDto } from '@six7swe/knowledge-types';
import type { Job, MatchEvidence, Profile } from '../../db/schema/jobHunt';

/**
 * Builds the candidate context handed to the canonical matcher.
 *
 * The matcher is profile-source agnostic: it accepts a context string and
 * knows nothing about where it came from. Here it is the search profile's own
 * fields, the owner's published profile summary, and the knowledge chunks
 * retrieved with the job description as the query.
 */

/**
 * Text a user typed or a job board served is data, never instructions. It is
 * fenced in these tags, and the matcher's system prompt says so
 * (`services/ai/prompts/jobMatch.ts`).
 */
export const PROFILE_NOTES_TAG = 'profile_notes';
export const JOB_POSTING_TAG = 'job_posting';

/**
 * Wraps untrusted text in `<tag>` ... `</tag>`. A tag of the same name inside
 * the text is defused first (`<` becomes `[`), so the text cannot close the
 * fence early and carry on as if it were outside it.
 */
export function untrusted(tag: string, text: string): string {
  const defused = text.replace(new RegExp(`<(\\s*/?\\s*${tag})`, 'gi'), '[$1');
  return `<${tag}>\n${defused}\n</${tag}>`;
}

export interface CandidateBackground {
  /** The published profile summary; null when none is published. */
  profileSummary: string | null;
  /** Chunks retrieved for this job, most relevant first. */
  chunks: readonly RetrievedChunkDto[];
}

export function buildSearchProfileContext(
  profile: Pick<Profile, 'keywords' | 'location' | 'additionalContext'>,
  background: CandidateBackground = { profileSummary: null, chunks: [] },
): string {
  const lines = [
    `- Keywords: ${(profile.keywords ?? []).join(', ') || 'Not specified'}`,
    `- Location: ${profile.location ?? 'Not specified'}`,
  ];

  if (profile.additionalContext) {
    lines.push('- Additional Context:', untrusted(PROFILE_NOTES_TAG, profile.additionalContext));
  }

  if (background.profileSummary) {
    lines.push('', 'Profile Summary:', background.profileSummary);
  }

  lines.push('', "Background (excerpts from the candidate's documents, most relevant first):");
  if (background.chunks.length === 0) {
    lines.push('No background documents are available.');
  } else {
    background.chunks.forEach((chunk, index) => {
      const heading = chunk.heading ? ` - ${chunk.heading}` : '';
      lines.push(`[${index + 1}] ${chunk.filename}${heading}`, chunk.content.trim(), '');
    });
  }

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

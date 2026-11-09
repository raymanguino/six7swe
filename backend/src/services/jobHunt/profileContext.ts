import type { Job, Profile } from '../../db/schema/jobHunt';

/**
 * Builds the candidate context handed to the canonical matcher.
 *
 * The matcher is profile-source agnostic: it accepts a context string and
 * knows nothing about where it came from. The public endpoint supplies the
 * portfolio owner's profile; the refresh pipeline supplies a search profile.
 */
export function buildSearchProfileContext(profile: Profile): string {
  const lines = [
    `- Keywords: ${(profile.keywords ?? []).join(', ') || 'Not specified'}`,
    `- Location: ${profile.location ?? 'Not specified'}`,
    `- Resume: ${profile.resume ?? 'Not provided'}`,
  ];

  if (profile.additionalContext) {
    lines.push(`- Additional Context: ${profile.additionalContext}`);
  }

  return lines.join('\n');
}

/** Renders a stored job row as the description text the matcher reads. */
export function buildJobDescription(job: Job): string {
  return [
    `- Title: ${job.position}`,
    `- Company: ${job.company}`,
    `- Location: ${job.location ?? 'Not specified'}`,
    `- Description: ${job.description || 'No description provided'}`,
    `- Link: ${job.link}`,
  ].join('\n');
}

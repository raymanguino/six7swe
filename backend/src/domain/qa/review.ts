/**
 * The review body the agent posts on a pull request.
 *
 * Pure domain logic: no IO, no framework imports. Rendering the body is
 * what a human reads, so it belongs with the other pure decisions rather
 * than inside the script that wires everything together.
 *
 * The marker lives here too, because it is part of the contract between
 * the body and the client that posts it: the client has to recognise the
 * agent's own review, and the body has to be the one that carries the
 * marker. Keeping the constant in one place stops them drifting apart.
 */

import { MAX_REPORTED_FINDINGS, type GateOutcome, type ReviewFinding } from './verdict';

/**
 * Hidden marker that identifies the agent's own review.
 *
 * It is an HTML comment, so GitHub renders nothing for it, and it is what
 * lets a later run find the review it posted before.
 */
export const REVIEW_MARKER = '<!-- six7swe-qa-agent -->';

function location(finding: ReviewFinding): string {
  if (finding.file === null) {
    return 'general';
  }

  return finding.line === null ? `\`${finding.file}\`` : `\`${finding.file}:${finding.line}\``;
}

/**
 * Renders the review body.
 *
 * It states the gate outcome explicitly, because the outcome and the
 * findings can disagree from the reader's point of view: a `manual-review`
 * outcome means the pull request touched a protected path and a human has
 * to look at it, whatever the model said.
 *
 * The findings are trimmed here, and only here. The gate has already seen
 * every finding by the time this runs, so trimming cannot hide a defect -
 * it only decides which ones the reviewer reads.
 */
export function renderReviewBody(
  summary: string,
  findings: readonly ReviewFinding[],
  gate: GateOutcome,
  commitSha: string,
): string {
  const lines: string[] = [REVIEW_MARKER, '', '## QA agent review', '', summary, ''];

  lines.push(`**Gate outcome: \`${gate}\`**`, `Reviewed commit: \`${commitSha}\``, '');

  const reported = findings.slice(0, MAX_REPORTED_FINDINGS);

  if (reported.length === 0) {
    lines.push('No findings. The model reported nothing against this diff.');
    return lines.join('\n');
  }

  lines.push('| Severity | Location | Finding |', '|---|---|---|');

  for (const finding of reported) {
    lines.push(`| ${finding.severity} | ${location(finding)} | ${finding.message} |`);
  }

  if (findings.length > reported.length) {
    lines.push('', `_${findings.length - reported.length} further finding(s) were not shown._`);
  }

  return lines.join('\n');
}

/**
 * Renders the body for a review that could not be completed.
 *
 * A broken agent is reported as an error, never as a finding about the
 * pull request. Conflating the two would make a false positive look like a
 * defect in the code under review.
 */
export function renderFailureBody(reason: string, commitSha: string): string {
  return [
    REVIEW_MARKER,
    '',
    '## QA agent review',
    '',
    'The review could not be completed, so no findings are reported.',
    '',
    '**Gate outcome: `fail-closed`**',
    `Reviewed commit: \`${commitSha}\``,
    '',
    `Reason: ${reason}`,
    '',
    'This is a failure of the review agent, not a finding about this pull request.',
  ].join('\n');
}

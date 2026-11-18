/**
 * Tallies the QA agent's runs into the phase 2 calibration table (#59).
 *
 * Reads every completed run of the QA Review workflow, pulls the one stats
 * line each run logs, and prints a Markdown table to paste into the issue.
 * Whether a finding was a real defect is a human judgement, kept in
 * `backend/qa/verdicts.json` and rendered by `qa:verdicts`, not here.
 *
 * GitHub deletes workflow logs after 90 days by default, so a run older
 * than that can no longer be counted. The report says how many were lost.
 *
 * Usage:
 *   pnpm --filter @six7swe/backend qa:calibration
 *
 * Environment:
 *   GITHUB_TOKEN or GH_TOKEN   required, a token that can read the repository's Actions logs
 *   GITHUB_REPOSITORY          optional, "owner/repo"; defaults to the `origin` remote
 */

import {
  renderCalibrationReport,
  REVIEW_DIFF_BUDGET,
  summarizeCalibration,
} from '../src/domain/qa';
import { readRunData, repository, token } from './qa-runs';

async function main(): Promise<void> {
  const data = await readRunData(repository(), token());

  process.stdout.write(
    renderCalibrationReport(summarizeCalibration(data.stats), {
      runs: data.runs,
      runsWithoutStats: data.runsWithoutStats,
      runsWithExpiredLogs: data.runsWithExpiredLogs,
      diffBudgetChars: REVIEW_DIFF_BUDGET.totalChars,
    }),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

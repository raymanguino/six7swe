/**
 * Checks whether the current branch fits the QA review's diff budget.
 *
 * The QA agent reads at most `REVIEW_DIFF_BUDGET` of a pull request's diff
 * and drops whole files beyond it. This measures the committed changes on
 * the current branch, against the branch the pull request will target,
 * with the same budgeting code, so a branch can be split before its pull
 * request is opened rather than after the review missed half of it.
 *
 * Only commits count: uncommitted changes are not part of a pull request.
 *
 * Usage:
 *   pnpm pr:size                      # against main
 *   pnpm pr:size --base feat/104-x    # a stacked pull request
 *
 * Exit codes: 0 fits, 1 over budget, 2 error.
 */

import { execFileSync } from 'node:child_process';
import { measurePrSize, parseUnifiedDiff, REVIEW_DIFF_BUDGET } from '../src/domain/qa';

function git(args: readonly string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
}

function refExists(ref: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function parseBase(argv: readonly string[]): string {
  // `pnpm pr:size -- --base x` forwards the `--` as well.
  const args = argv.filter((arg) => arg !== '--');
  const index = args.indexOf('--base');
  if (index === -1) {
    return 'main';
  }

  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error('--base needs a branch name');
  }

  return value;
}

/**
 * Prefers the remote-tracking branch: a stale local `main` would move the
 * merge base back and count other people's commits as this branch's.
 */
function resolveBase(base: string): string {
  const remote = `origin/${base}`;
  if (!base.startsWith('origin/') && refExists(remote)) {
    return remote;
  }
  if (refExists(base)) {
    return base;
  }

  throw new Error(`Base branch not found: ${base} (try git fetch)`);
}

function main(): void {
  const base = resolveBase(parseBase(process.argv.slice(2)));
  const diff = git(['diff', '--no-color', '--no-ext-diff', '-M', `${base}...HEAD`]);
  const report = measurePrSize(parseUnifiedDiff(diff), REVIEW_DIFF_BUDGET, base);

  process.stdout.write(`${report.text}\n`);
  process.exitCode = report.fits ? 0 : 1;
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}

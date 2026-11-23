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
 * The result is an upper bound. GitHub leaves out the patch of a very large
 * file, which the review then lists without its text; locally every file
 * has its patch, so a branch can only measure larger here, never smaller.
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

/** Whether a git command exits 0; for the commands whose answer is their exit code. */
function succeeds(args: readonly string[]): boolean {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}

function refExists(ref: string): boolean {
  return succeeds(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

function isAncestor(ancestor: string, descendant: string): boolean {
  return succeeds(['merge-base', '--is-ancestor', ancestor, descendant]);
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
 * Picks whichever of `<base>` and `origin/<base>` is further ahead.
 *
 * A base that is behind moves the merge base back and counts its missing
 * commits as this branch's: a stale local `main` counts other people's
 * merged work, and a stale `origin/<parent>` counts a stacked parent's
 * unpushed commits. When the two have diverged, the remote is used, with a
 * warning.
 */
function resolveBase(base: string): string {
  const remote = `origin/${base}`;
  const hasRemote = !base.startsWith('origin/') && refExists(remote);
  const hasLocal = refExists(base);

  if (hasRemote && hasLocal) {
    if (isAncestor(remote, base)) return base;
    if (!isAncestor(base, remote)) {
      process.stderr.write(`${base} and ${remote} have diverged; measuring against ${remote}.\n`);
    }
    return remote;
  }
  if (hasRemote) return remote;
  if (hasLocal) return base;

  throw new Error(`Base branch not found: ${base} (try git fetch)`);
}

function main(): void {
  const base = resolveBase(parseBase(process.argv.slice(2)));
  // Everything that shapes the patch is pinned to git's defaults, which is
  // what GitHub shows, so the user's git config (noprefix, mnemonicPrefix,
  // textconv, diff.context, diff.algorithm, diff.indentHeuristic) cannot
  // change the paths, hunks or patch lengths.
  const diff = git([
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--unified=3',
    '--diff-algorithm=myers',
    '--indent-heuristic',
    '-M',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    `${base}...HEAD`,
    '--',
  ]);
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

/**
 * Turns local `git diff` output into the files a pull request would list.
 *
 * Pure domain logic: the caller runs git. The QA agent reads a pull
 * request's files from the GitHub API; this produces the same `ChangedFile`
 * shape from a local unified diff, so local checks (`pr:size`) budget it
 * exactly as the review does.
 */

import type { ChangedFile } from './diff';

const SECTION_PREFIX = 'diff --git ';

/**
 * Undoes git's quoting of an unusual path (`"a/with \"quote\""`).
 *
 * With `core.quotePath=false` git only quotes paths holding control
 * characters, quotes or backslashes, so the common escapes are enough.
 */
function unquote(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"'))) {
    return path;
  }

  return path.slice(1, -1).replace(/\\(.)/g, (_, char: string) => {
    switch (char) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      default:
        return char;
    }
  });
}

/** The path on a `---` / `+++` line, without its `a/` or `b/` prefix; null for /dev/null. */
function markerPath(value: string): string | null {
  // git appends a tab to the marker line when the path contains a space.
  const path = unquote(value.replace(/\t$/, ''));
  if (path === '/dev/null') {
    return null;
  }

  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

/**
 * The path from a `diff --git a/P b/P` line, when both sides are the same.
 *
 * Only used for a section with no `---`/`+++` lines and no rename (a binary
 * file or a mode change). A path with spaces makes the line ambiguous in
 * general, but when both sides are equal its length settles it.
 */
function sectionPath(line: string): string | null {
  const rest = line.slice(SECTION_PREFIX.length);
  const length = (rest.length - 5) / 2;
  if (!Number.isInteger(length) || length <= 0) {
    return null;
  }

  const oldPath = rest.slice(2, 2 + length);
  const newPath = rest.slice(length + 5);
  return rest.startsWith('a/') &&
    rest.slice(length + 2, length + 5) === ' b/' &&
    oldPath === newPath
    ? oldPath
    : null;
}

function parseSection(lines: readonly string[]): ChangedFile {
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  const header = firstHunk === -1 ? lines : lines.slice(0, firstHunk);
  const hunks = firstHunk === -1 ? [] : lines.slice(firstHunk);

  let oldPath: string | null = null;
  let newPath: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let added = false;
  let removed = false;

  for (const line of header) {
    if (line.startsWith('--- ')) {
      oldPath = markerPath(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      newPath = markerPath(line.slice(4));
    } else if (line.startsWith('rename from ')) {
      renameFrom = unquote(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      renameTo = unquote(line.slice('rename to '.length));
    } else if (line.startsWith('new file mode')) {
      added = true;
    } else if (line.startsWith('deleted file mode')) {
      removed = true;
    }
  }

  const filename = renameTo ?? newPath ?? oldPath ?? sectionPath(lines[0] ?? '') ?? '(unknown)';
  const status = added ? 'added' : removed ? 'removed' : renameTo ? 'renamed' : 'modified';

  let additions = 0;
  let deletions = 0;
  for (const line of hunks) {
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }

  const file: ChangedFile = { filename, status, additions, deletions };
  if (renameFrom !== null && renameTo !== null) {
    file.previousFilename = renameFrom;
  }
  if (hunks.length > 0) {
    // GitHub's `patch` is the hunks alone, from the first `@@`, with no
    // trailing newline.
    file.patch = hunks.join('\n');
  }

  return file;
}

/**
 * Turns `git diff` output into the files a pull request would list.
 *
 * Expects the output of `git diff --no-color --no-ext-diff -M`, ideally
 * with `-c core.quotePath=false`. Each file's `patch` matches what the
 * GitHub API returns for it: the hunks only.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  // The output ends with a newline, which leaves one empty line behind. A
  // real empty context line is a single space, so this is never content.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const sections: string[][] = [];
  for (const line of lines) {
    if (line.startsWith(SECTION_PREFIX)) {
      sections.push([line]);
    } else {
      sections[sections.length - 1]?.push(line);
    }
  }

  return sections.map(parseSection);
}

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

/** git's single-character C escapes (`quote_c_style` in git's quote.c). */
const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c,
};

/**
 * Reads one git C-quoted string (`"a/with \"quote\" and \001"`) that starts
 * at `start`, returning its decoded text and the index just past it.
 *
 * Escapes are decoded to bytes and the bytes as UTF-8, because git escapes
 * a byte at a time: a non-ASCII character can arrive as several octal
 * escapes. Returns null when the string is not terminated.
 */
function readQuoted(text: string, start: number): { value: string; end: number } | null {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let i = start + 1;

  while (i < text.length) {
    const char = text[i] as string;
    if (char === '"') {
      return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
    }
    if (char === '\\') {
      const octal = /^[0-7]{3}/.exec(text.slice(i + 1, i + 4));
      if (octal) {
        bytes.push(parseInt(octal[0], 8));
        i += 4;
        continue;
      }
      const escaped = C_ESCAPES[text[i + 1] ?? ''];
      if (escaped !== undefined) {
        bytes.push(escaped);
        i += 2;
        continue;
      }
    }
    // A character outside an escape stands for itself (UTF-8 encoded).
    const codePoint = text.codePointAt(i) as number;
    const literal = String.fromCodePoint(codePoint);
    bytes.push(...encoder.encode(literal));
    i += literal.length;
  }

  return null;
}

/** Undoes git's quoting of an unusual path; a path git did not quote is returned as is. */
function unquote(path: string): string {
  if (!path.startsWith('"')) {
    return path;
  }

  const quoted = readQuoted(path, 0);
  return quoted !== null && quoted.end === path.length ? quoted.value : path;
}

/** Removes the `a/` or `b/` prefix the caller pins with `--src-prefix` / `--dst-prefix`. */
function withoutPrefix(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

/** The path on a `---` / `+++` line, without its `a/` or `b/` prefix; null for /dev/null. */
function markerPath(value: string): string | null {
  // git appends a tab to the marker line when the path contains a space.
  const path = unquote(value.replace(/\t$/, ''));
  if (path === '/dev/null') {
    return null;
  }

  return withoutPrefix(path);
}

/**
 * The path from a `diff --git a/P b/P` line, when both sides are the same.
 *
 * Only used for a section with no `---`/`+++` lines and no rename (a binary
 * file or a mode change). A quoted path is read token by token. An unquoted
 * path with spaces makes the line ambiguous in general, but when both sides
 * are equal its length settles it.
 */
function sectionPath(line: string): string | null {
  const rest = line.slice(SECTION_PREFIX.length);

  if (rest.startsWith('"')) {
    const oldSide = readQuoted(rest, 0);
    if (oldSide === null || rest[oldSide.end] !== ' ') {
      return null;
    }
    const newText = rest.slice(oldSide.end + 1);
    const newSide = newText.startsWith('"') ? readQuoted(newText, 0) : null;
    const newPath = newSide !== null && newSide.end === newText.length ? newSide.value : newText;
    const oldPath = withoutPrefix(oldSide.value);
    return oldSide.value.startsWith('a/') && newPath === `b/${oldPath}` ? oldPath : null;
  }

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
 * Expects the output of `git diff --no-color --no-ext-diff --no-textconv -M
 * --src-prefix=a/ --dst-prefix=b/`, ideally with `-c core.quotePath=false`.
 * Each file's `patch` matches what the GitHub API returns for it: the hunks
 * only, byte for byte.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  // git separates diff lines with "\n" on every platform, so a "\r" is the
  // file's own content (a CRLF file) and is kept: GitHub keeps it too, and
  // the review shows each one escaped, so it costs budget there.
  const lines = diff.split('\n');
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

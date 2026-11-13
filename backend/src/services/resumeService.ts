import fs from 'fs';
import path from 'path';
import { isPortfolioMcpEnabled } from '../config/portfolioMcp';

/** Served when the profile names a file that is not on disk. */
export const FALLBACK_RESUME_FILENAME = 'resume.pdf';

/**
 * Where the resume PDF is read from: `public/` under the backend's working directory.
 *
 * `backend/public/*.pdf` is gitignored, so a deploy only has a resume if one is placed there by
 * other means. See #104.
 */
export function resumeDirectory(): string {
  return path.join(process.cwd(), 'public');
}

/**
 * The profile's resume filename if it is a plain file name, else `resume.pdf`.
 *
 * The name comes from the database and is joined onto `public/`, sent to the MCP server and put
 * in the `Content-Disposition` header, so anything with a directory part (`../x.pdf`, `/etc/x`,
 * `a\b.pdf` on Windows), a quote or a control character is refused rather than trusted.
 */
export function safeResumeFilename(filename: string | null | undefined): string {
  if (
    !filename ||
    filename === '.' ||
    filename === '..' ||
    path.basename(filename) !== filename ||
    /["\\/\p{Cc}]/u.test(filename)
  ) {
    return FALLBACK_RESUME_FILENAME;
  }
  return filename;
}

/**
 * The local resume to serve: the profile's file if present, else `resume.pdf`, else null.
 * Never a path outside `directory` (see `safeResumeFilename`).
 */
export function findLocalResume(
  filename: string | null | undefined,
  directory: string = resumeDirectory(),
): string | null {
  const candidates = [safeResumeFilename(filename), FALLBACK_RESUME_FILENAME];
  for (const candidate of candidates) {
    const candidatePath = path.join(directory, candidate);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

/**
 * Whether `GET /resume` can be expected to return a PDF, so the site only links to one that exists.
 *
 * With the MCP source enabled the PDF is fetched on demand, so availability is assumed rather than
 * checked; the request itself falls back to the local file.
 */
export function isResumeAvailable(
  filename: string | null | undefined,
  directory: string = resumeDirectory(),
): boolean {
  return isPortfolioMcpEnabled() || findLocalResume(filename, directory) !== null;
}

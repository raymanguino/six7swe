import fs from 'fs';
import type { FastifyBaseLogger } from 'fastify';
import { getDefaultProfileClient } from './knowledge/profileClient';
import { getPortfolioData } from './portfolioService';
import type { PortfolioData } from '../types/portfolio';
import {
  FALLBACK_RESUME_FILENAME,
  findLocalResume,
  resumeDirectory,
  safeResumeFilename,
} from './resumeService';

/** The resume PDF to download, and the name to offer it under. */
export type ResumeDownload =
  | { found: true; filename: string; body: Buffer | fs.ReadStream }
  | {
      found: false;
      /** What was looked for, for the "not found" log. */
      filename: string;
      fallback: string;
      directory: string;
    };

/**
 * The primary resume from the knowledge service, or null when it has none.
 * A failure is logged and treated as none, so the next source can answer.
 */
async function fetchKnowledgeResume(log: FastifyBaseLogger): Promise<Buffer | null> {
  const client = getDefaultProfileClient();
  if (!client) return null;
  try {
    return await client.getResumePdf();
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Could not fetch the resume from the knowledge service',
    );
    return null;
  }
}

/**
 * Finds the resume PDF, trying each source in turn:
 *
 * 1. The knowledge service's primary resume (#86), named as it was uploaded.
 * 2. A file under `public/` (the profile's name, then `resume.pdf`).
 */
export async function getResumeDownload(log: FastifyBaseLogger): Promise<ResumeDownload> {
  // A cold-start outage must not hide a resume that is on disk, so a failure here only costs
  // the uploaded filename.
  let portfolio: PortfolioData | null = null;
  try {
    portfolio = await getPortfolioData();
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Could not load the portfolio for the resume; trying the local file',
    );
  }

  const pdf = await fetchKnowledgeResume(log);
  if (pdf) {
    return {
      found: true,
      filename: safeResumeFilename(portfolio?.knowledgeResume?.filename),
      body: pdf,
    };
  }

  const filename = safeResumeFilename(portfolio?.profile?.resumeFilename);
  const localPath = findLocalResume(filename);
  if (localPath) return { found: true, filename, body: fs.createReadStream(localPath) };

  return {
    found: false,
    filename,
    fallback: FALLBACK_RESUME_FILENAME,
    directory: resumeDirectory(),
  };
}

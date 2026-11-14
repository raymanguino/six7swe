import fs from 'fs';
import type { FastifyBaseLogger } from 'fastify';
import { getPortfolioDataSource, isMcpConnectionConfigured } from '../config/portfolioMcp';
import { getDefaultProfileClient } from './knowledge/profileClient';
import { fetchResumePdfFromMcp } from './mcpPortfolioClient';
import { getPortfolioData } from './portfolioService';
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
 * 1. With `PORTFOLIO_DATA_SOURCE=knowledge`, the knowledge service's primary
 *    resume (#86), named as it was uploaded.
 * 2. With `PORTFOLIO_DATA_SOURCE=mcp`, the MCP server's file (the profile's
 *    name, then `resume.pdf`).
 * 3. A file under `public/` (the profile's name, then `resume.pdf`).
 */
export async function getResumeDownload(log: FastifyBaseLogger): Promise<ResumeDownload> {
  const portfolio = await getPortfolioData();
  const source = getPortfolioDataSource();

  if (source === 'knowledge') {
    const pdf = await fetchKnowledgeResume(log);
    if (pdf) {
      const name = portfolio.knowledgeResume?.filename ?? portfolio.profile?.resumeFilename;
      return { found: true, filename: safeResumeFilename(name), body: pdf };
    }
  }

  const filename = safeResumeFilename(portfolio.profile?.resumeFilename);

  if (source === 'mcp' && isMcpConnectionConfigured()) {
    let buffer = await fetchResumePdfFromMcp(filename);
    if (!buffer || buffer.length === 0) {
      buffer = await fetchResumePdfFromMcp(FALLBACK_RESUME_FILENAME);
    }
    if (buffer && buffer.length > 0) return { found: true, filename, body: buffer };
  }

  const localPath = findLocalResume(filename);
  if (localPath) return { found: true, filename, body: fs.createReadStream(localPath) };

  return {
    found: false,
    filename,
    fallback: FALLBACK_RESUME_FILENAME,
    directory: resumeDirectory(),
  };
}

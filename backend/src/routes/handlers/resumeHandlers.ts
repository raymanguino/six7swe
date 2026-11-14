import { FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import { getPortfolioData } from '../../services/portfolioService';
import { getPortfolioDataSource, isMcpConnectionConfigured } from '../../config/portfolioMcp';
import { fetchResumePdfFromMcp } from '../../services/mcpPortfolioClient';
import { getDefaultProfileClient } from '../../services/knowledge/profileClient';
import {
  FALLBACK_RESUME_FILENAME,
  findLocalResume,
  resumeDirectory,
  safeResumeFilename,
} from '../../services/resumeService';

/**
 * `Content-Disposition` for a download. Header values must be Latin-1 (Node
 * throws on anything else), so `filename` gets an ASCII version and the real
 * name goes in RFC 5987's `filename*`, which browsers prefer.
 */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function sendPdf(reply: FastifyReply, filename: string, body: Buffer | fs.ReadStream) {
  reply.header('Content-Type', 'application/pdf');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Disposition', attachmentDisposition(filename));
  return reply.send(body);
}

/**
 * The primary resume from the knowledge service, or null when it has none.
 * A failure is logged and treated as none, so the local file can still answer.
 */
async function fetchKnowledgeResume(request: FastifyRequest): Promise<Buffer | null> {
  const client = getDefaultProfileClient();
  if (!client) return null;
  try {
    return await client.getResumePdf();
  } catch (error) {
    request.log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Could not fetch the resume from the knowledge service',
    );
    return null;
  }
}

export async function resumeHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const portfolio = await getPortfolioData();
    const source = getPortfolioDataSource();

    // The knowledge service's primary resume (#86), named as it was uploaded.
    if (source === 'knowledge') {
      const pdf = await fetchKnowledgeResume(request);
      if (pdf) {
        const name = portfolio.knowledgeResume?.filename ?? portfolio.profile?.resumeFilename;
        return sendPdf(reply, safeResumeFilename(name), pdf);
      }
    }

    const filename = safeResumeFilename(portfolio.profile?.resumeFilename);

    if (source === 'mcp' && isMcpConnectionConfigured()) {
      let buffer = await fetchResumePdfFromMcp(filename);
      if (!buffer || buffer.length === 0) {
        buffer = await fetchResumePdfFromMcp(FALLBACK_RESUME_FILENAME);
      }
      if (buffer && buffer.length > 0) return sendPdf(reply, filename, buffer);
    }

    const localPath = findLocalResume(filename);
    if (localPath) return sendPdf(reply, filename, fs.createReadStream(localPath));

    // Logged so a deploy without a resume shows up in the logs instead of only in the browser.
    request.log.warn(
      { filename, fallback: FALLBACK_RESUME_FILENAME, directory: resumeDirectory() },
      'Resume not found',
    );
    return reply.code(404).send({ error: 'Resume not found' });
  } catch (error) {
    request.log.error(error, 'Error serving resume');
    return reply.code(500).send({ error: 'Failed to serve resume' });
  }
}

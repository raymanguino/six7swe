import { FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import { getPortfolioData } from '../../services/portfolioService';
import { getPortfolioDataSource, isMcpConnectionConfigured } from '../../config/portfolioMcp';
import { fetchResumePdfFromMcp } from '../../services/mcpPortfolioClient';
import {
  FALLBACK_RESUME_FILENAME,
  findLocalResume,
  resumeDirectory,
} from '../../services/resumeService';

export async function resumeHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { profile } = await getPortfolioData();
    const filename = profile?.resumeFilename || FALLBACK_RESUME_FILENAME;

    if (getPortfolioDataSource() === 'mcp' && isMcpConnectionConfigured()) {
      let buffer = await fetchResumePdfFromMcp(filename);
      if (!buffer || buffer.length === 0) {
        buffer = await fetchResumePdfFromMcp(FALLBACK_RESUME_FILENAME);
      }
      if (buffer && buffer.length > 0) {
        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
        return reply.send(buffer);
      }
    }

    const localPath = findLocalResume(filename);
    if (localPath) {
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(fs.createReadStream(localPath));
    }

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

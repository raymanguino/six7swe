import { FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import path from 'path';
import { getPortfolioData } from '../../services/portfolioService';
import { getPortfolioDataSource, isMcpConnectionConfigured } from '../../config/portfolioMcp';
import { fetchResumePdfFromMcp } from '../../services/mcpPortfolioClient';

export async function resumeHandler(_request: FastifyRequest, reply: FastifyReply) {
  try {
    const { profile } = await getPortfolioData();
    const filename = profile?.resumeFilename || 'resume.pdf';
    const publicDir = path.join(process.cwd(), 'public');
    const localPath = path.join(publicDir, filename);
    const fallbackFilename = 'resume.pdf';
    const fallbackLocalPath = path.join(publicDir, fallbackFilename);

    if (getPortfolioDataSource() === 'mcp' && isMcpConnectionConfigured()) {
      let buffer = await fetchResumePdfFromMcp(filename);
      if (!buffer || buffer.length === 0) {
        buffer = await fetchResumePdfFromMcp(fallbackFilename);
      }
      if (buffer && buffer.length > 0) {
        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
        return reply.send(buffer);
      }
    }

    const hasLocal = fs.existsSync(localPath);
    const hasFallbackLocal = fs.existsSync(fallbackLocalPath);

    if (hasLocal) {
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(fs.createReadStream(localPath));
    }

    if (hasFallbackLocal) {
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(fs.createReadStream(fallbackLocalPath));
    }

    return reply.code(404).send({ error: 'Resume not found' });
  } catch (error) {
    _request.log.error(error, 'Error serving resume');
    return reply.code(500).send({ error: 'Failed to serve resume' });
  }
}

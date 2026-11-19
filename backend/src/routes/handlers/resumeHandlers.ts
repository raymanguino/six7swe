import { FastifyRequest, FastifyReply } from 'fastify';
import { getResumeDownload } from '../../services/resumeDownload';

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

function sendPdf(reply: FastifyReply, filename: string, body: Buffer) {
  reply.header('Content-Type', 'application/pdf');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Disposition', attachmentDisposition(filename));
  return reply.send(body);
}

export async function resumeHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const resume = await getResumeDownload(request.log);
    if (resume.found) return sendPdf(reply, resume.filename, resume.body);

    request.log.warn('Resume not found: the knowledge service has no primary resume');
    return reply.code(404).send({ error: 'Resume not found' });
  } catch (error) {
    request.log.error(error, 'Error serving resume');
    return reply.code(500).send({ error: 'Failed to serve resume' });
  }
}

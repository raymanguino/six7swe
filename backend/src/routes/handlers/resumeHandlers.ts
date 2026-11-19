import type { FastifyRequest, FastifyReply } from 'fastify';
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

/**
 * Whether an `If-None-Match` header matches `etag`: `*`, or a comma-separated list of entity
 * tags compared weakly (a `W/` prefix is ignored), as RFC 9110 requires for conditional GETs.
 */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const strong = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((tag) => strong(tag) === strong(etag));
}

/** The name the resume is offered under; the service does not send the uploaded name. */
const RESUME_FILENAME = 'resume.pdf';

export async function resumeHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const resume = await getResumeDownload(request.log);
    if (!resume.found) {
      request.log.warn('Resume not found: the knowledge service has no primary resume');
      reply.header('Cache-Control', 'no-store');
      return reply.code(404).send({ error: 'Resume not found' });
    }

    // Revalidated on every download; the ETag (the corpus version) makes that a cheap 304.
    reply.header('Cache-Control', 'public, max-age=0, must-revalidate');
    reply.header('ETag', resume.etag);
    if (ifNoneMatchHits(request.headers['if-none-match'], resume.etag)) return reply.code(304).send();

    reply.header('Content-Type', 'application/pdf');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Disposition', attachmentDisposition(RESUME_FILENAME));
    return reply.send(resume.body);
  } catch (error) {
    request.log.error(error, 'Error serving resume');
    return reply.code(500).send({ error: 'Failed to serve resume' });
  }
}

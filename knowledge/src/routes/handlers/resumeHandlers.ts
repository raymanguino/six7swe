import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireOwner } from '../../plugins/serviceAuth.js';
import { getPrimaryResumePdf } from '../../services/resume.js';
import type { KnowledgeContext } from '../context.js';

export function resumeHandlers(ctx: KnowledgeContext) {
  return {
    /** Service: the primary resume's file, when it is a PDF. The backend serves it as `/resume`. */
    async resumePdf(req: FastifyRequest, reply: FastifyReply) {
      const bytes = await getPrimaryResumePdf(ctx, requireOwner(req));
      if (!bytes) return reply.code(404).send({ error: 'No PDF resume' });
      return reply
        .header('content-type', 'application/pdf')
        .header('content-length', bytes.byteLength)
        .send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    },
  };
}

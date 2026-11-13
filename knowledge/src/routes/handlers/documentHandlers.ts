import type { FastifyReply, FastifyRequest } from 'fastify';
import { DocumentParamsSchema, UploadQuerySchema } from '../../contract.js';
import { requireOwner } from '../../plugins/serviceAuth.js';
import {
  deleteDocument,
  getDocument,
  listDocuments,
  uploadDocument,
} from '../../services/documents.js';
import type { KnowledgeContext } from '../context.js';
import { toDocumentDto } from '../mappers.js';

export function documentHandlers(ctx: KnowledgeContext) {
  const deps = (req: FastifyRequest) => ({
    repo: ctx.repo,
    files: ctx.files,
    queue: ctx.queue,
    log: req.log,
  });

  return {
    /**
     * Multipart upload with a single `file` part. The document kind comes from
     * the query string (`?kind=resume`) so it does not depend on part order.
     */
    async upload(req: FastifyRequest, reply: FastifyReply) {
      const ownerId = requireOwner(req);
      const { kind } = UploadQuerySchema.parse(req.query);
      // The size and file-count limits are the ones registered with the plugin.
      const part = await req.file();
      if (!part) {
        return reply.code(400).send({ error: 'Expected a multipart body with a file part' });
      }

      // Throws a 413 (RequestFileTooLargeError) once the limit is crossed.
      const bytes = await part.toBuffer();
      const { document, deduplicated } = await uploadDocument(deps(req), {
        ownerId,
        filename: part.filename,
        bytes,
        kind,
      });

      return reply.code(deduplicated ? 200 : 202).send({
        document: toDocumentDto(document),
        deduplicated,
      });
    },

    async list(req: FastifyRequest) {
      const documents = await listDocuments(ctx, requireOwner(req));
      return { documents: documents.map(toDocumentDto) };
    },

    async get(req: FastifyRequest, reply: FastifyReply) {
      const ownerId = requireOwner(req);
      const { id } = DocumentParamsSchema.parse(req.params);
      const document = await getDocument(ctx, ownerId, id);
      if (!document) return reply.code(404).send({ error: 'Document not found' });
      return { document: toDocumentDto(document) };
    },

    async remove(req: FastifyRequest, reply: FastifyReply) {
      const ownerId = requireOwner(req);
      const { id } = DocumentParamsSchema.parse(req.params);
      const deleted = await deleteDocument(deps(req), ownerId, id);
      if (!deleted) return reply.code(404).send({ error: 'Document not found' });
      return reply.code(204).send();
    },
  };
}

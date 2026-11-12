import type { FastifyReply, FastifyRequest } from 'fastify';
import { DocumentParamsSchema, toDocumentDto, UploadQuerySchema } from '../../contract.js';
import { deleteDocument, uploadDocument } from '../../services/documents.js';
import type { KnowledgeContext } from '../context.js';

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
      const { kind } = UploadQuerySchema.parse(req.query);
      const part = await req.file({ limits: { fileSize: ctx.maxUploadBytes, files: 1 } });
      if (!part) {
        return reply.code(400).send({ error: 'Expected a multipart body with a file part' });
      }

      // Throws a 413 (RequestFileTooLargeError) once the limit is crossed.
      const bytes = new Uint8Array(await part.toBuffer());
      const { document, deduplicated } = await uploadDocument(deps(req), {
        ownerId: ctx.ownerId,
        filename: part.filename,
        bytes,
        kind,
      });

      return reply.code(deduplicated ? 200 : 202).send({
        document: toDocumentDto(document),
        deduplicated,
      });
    },

    async list() {
      const documents = await ctx.repo.listDocuments(ctx.ownerId);
      return { documents: documents.map(toDocumentDto) };
    },

    async get(req: FastifyRequest, reply: FastifyReply) {
      const { id } = DocumentParamsSchema.parse(req.params);
      const document = await ctx.repo.getDocument(ctx.ownerId, id);
      if (!document) return reply.code(404).send({ error: 'Document not found' });
      return { document: toDocumentDto(document) };
    },

    async remove(req: FastifyRequest, reply: FastifyReply) {
      const { id } = DocumentParamsSchema.parse(req.params);
      const { deleted } = await deleteDocument(deps(req), ctx.ownerId, id);
      if (!deleted) return reply.code(404).send({ error: 'Document not found' });
      return reply.code(204).send();
    },
  };
}

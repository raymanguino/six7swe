import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  IdParamsSchema,
  UploadQuerySchema,
  type DocumentFindingsResponse,
  type DocumentResponse,
  type DocumentTextResponse,
} from '../../contract.js';
import { requireOwner } from '../../plugins/serviceAuth.js';
import {
  approveDocument,
  deleteDocument,
  getDocument,
  getDocumentFindings,
  getDocumentText,
  listDocuments,
  setPrimaryResume,
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
    onCorpusChanged: (ownerId: string) => ctx.evalRunner.corpusChanged(ownerId),
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
      const { id } = IdParamsSchema.parse(req.params);
      const document = await getDocument(ctx, ownerId, id);
      if (!document) return reply.code(404).send({ error: 'Document not found' });
      return { document: toDocumentDto(document) };
    },

    /** The extracted text, for the owner's preview. */
    async text(req: FastifyRequest, reply: FastifyReply) {
      const ownerId = requireOwner(req);
      const { id } = IdParamsSchema.parse(req.params);
      const found = await getDocumentText(ctx, ownerId, id);
      if (!found) return reply.code(404).send({ error: 'Document not found' });
      const body: DocumentTextResponse = { documentId: id, text: found.text };
      return body;
    },

    /** The findings of the document's last risk scan (#212), for the owner's review. */
    async findings(req: FastifyRequest, reply: FastifyReply) {
      const ownerId = requireOwner(req);
      const { id } = IdParamsSchema.parse(req.params);
      const found = await getDocumentFindings(ctx, ownerId, id);
      if (!found) return reply.code(404).send({ error: 'Document not found' });
      const body: DocumentFindingsResponse = {
        document: toDocumentDto(found.document),
        findings: found.findings,
      };
      return body;
    },

    /** Approves the findings as they are (#212); 409 when there is nothing to approve. */
    async approve(req: FastifyRequest, reply: FastifyReply) {
      const ownerId = requireOwner(req);
      const { id } = IdParamsSchema.parse(req.params);
      const document = await approveDocument(deps(req), ownerId, id);
      if (!document) return reply.code(404).send({ error: 'Document not found' });
      const body: DocumentResponse = { document: toDocumentDto(document) };
      return body;
    },

    /** Makes a ready resume the primary one; 409 for anything else. */
    async setPrimary(req: FastifyRequest, reply: FastifyReply) {
      const ownerId = requireOwner(req);
      const { id } = IdParamsSchema.parse(req.params);
      const document = await setPrimaryResume(ctx, ownerId, id);
      if (!document) return reply.code(404).send({ error: 'Document not found' });
      return { document: toDocumentDto(document) };
    },

    async remove(req: FastifyRequest, reply: FastifyReply) {
      const ownerId = requireOwner(req);
      const { id } = IdParamsSchema.parse(req.params);
      const deleted = await deleteDocument(deps(req), ownerId, id);
      if (!deleted) return reply.code(404).send({ error: 'Document not found' });
      return reply.code(204).send();
    },
  };
}

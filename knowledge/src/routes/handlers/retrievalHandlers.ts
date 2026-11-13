import type { FastifyRequest } from 'fastify';
import { RetrieveRequestSchema, type RetrieveResponse } from '../../contract.js';
import { requireOwner } from '../../plugins/serviceAuth.js';
import { getCorpusVersion, retrieve } from '../../services/retrieval.js';
import type { KnowledgeContext } from '../context.js';
import { toChunkDto } from '../mappers.js';

export function retrievalHandlers(ctx: KnowledgeContext) {
  return {
    async retrieve(req: FastifyRequest): Promise<RetrieveResponse> {
      const ownerId = requireOwner(req);
      const { query, k } = RetrieveRequestSchema.parse(req.body);
      const result = await retrieve(ctx, ownerId, query, k);
      return { version: result.version, chunks: result.chunks.map(toChunkDto) };
    },

    async version(req: FastifyRequest) {
      return { version: await getCorpusVersion(ctx, requireOwner(req)) };
    },
  };
}

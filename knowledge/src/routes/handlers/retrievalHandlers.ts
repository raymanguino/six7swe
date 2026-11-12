import type { FastifyRequest } from 'fastify';
import { RetrieveRequestSchema, toChunkDto, type RetrieveResponse } from '../../contract.js';
import { retrieve } from '../../services/retrieval.js';
import type { KnowledgeContext } from '../context.js';

export function retrievalHandlers(ctx: KnowledgeContext) {
  return {
    async retrieve(req: FastifyRequest): Promise<RetrieveResponse> {
      const { query, k } = RetrieveRequestSchema.parse(req.body);
      const result = await retrieve(ctx, ctx.ownerId, query, k);
      return { version: result.version, chunks: result.chunks.map(toChunkDto) };
    },

    async version() {
      return { version: await ctx.repo.getVersion(ctx.ownerId) };
    },
  };
}

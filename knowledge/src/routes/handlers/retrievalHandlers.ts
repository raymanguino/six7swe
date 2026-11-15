import type { FastifyRequest } from 'fastify';
import {
  RetrieveRequestSchema,
  SearchRequestSchema,
  type RetrieveResponse,
} from '../../contract.js';
import { requireOwner } from '../../plugins/serviceAuth.js';
import { getCorpusVersion, retrieve } from '../../services/retrieval.js';
import type { KnowledgeContext } from '../context.js';
import { toRetrieveResponse } from '../mappers.js';

export function retrievalHandlers(ctx: KnowledgeContext) {
  return {
    /** Service: chat retrieval; records the question for the eval set when asked to (#85). */
    async retrieve(req: FastifyRequest): Promise<RetrieveResponse> {
      const ownerId = requireOwner(req);
      const { query, k, record, sessionId } = RetrieveRequestSchema.parse(req.body);
      const result = await retrieve(ctx, ownerId, query, k);
      if (record && sessionId) {
        // In the background: recording never delays or fails the answer.
        ctx.evalSet.enqueueRecord({
          ownerId,
          question: query,
          sessionId,
          embedding: result.embedding,
          topSimilarity: result.chunks[0]?.similarity ?? null,
        });
      }
      return toRetrieveResponse(result);
    },

    /** Owner: the "ask as a visitor" playground. Strict, and never recorded. */
    async search(req: FastifyRequest): Promise<RetrieveResponse> {
      const ownerId = requireOwner(req);
      const { query, k } = SearchRequestSchema.parse(req.body);
      return toRetrieveResponse(await retrieve(ctx, ownerId, query, k));
    },

    async version(req: FastifyRequest) {
      return { version: await getCorpusVersion(ctx, requireOwner(req)) };
    },
  };
}

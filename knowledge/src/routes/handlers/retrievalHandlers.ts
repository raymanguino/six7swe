import type { FastifyRequest } from 'fastify';
import { RetrieveRequestSchema, type RetrieveResponse } from '../../contract.js';
import { requireOwner } from '../../plugins/serviceAuth.js';
import { getCorpusVersion, retrieve } from '../../services/retrieval.js';
import type { KnowledgeContext } from '../context.js';
import { toChunkDto } from '../mappers.js';

export function retrievalHandlers(ctx: KnowledgeContext) {
  async function run(req: FastifyRequest, { recording }: { recording: boolean }) {
    const ownerId = requireOwner(req);
    const { query, k, record, sessionId } = RetrieveRequestSchema.parse(req.body);
    const result = await retrieve(ctx, ownerId, query, k);
    if (recording && record && sessionId) {
      // In the background: recording never delays or fails the answer.
      ctx.evalSet.enqueueRecord({
        ownerId,
        question: query,
        sessionId,
        embedding: result.embedding,
        topSimilarity: result.chunks[0]?.similarity ?? null,
      });
    }
    const body: RetrieveResponse = {
      version: result.version,
      chunks: result.chunks.map(toChunkDto),
    };
    return body;
  }

  return {
    /** Service: chat retrieval; records the question for the eval set when asked to (#85). */
    retrieve: (req: FastifyRequest) => run(req, { recording: true }),

    /** Owner: the "ask as a visitor" playground. The owner's own questions are never recorded. */
    search: (req: FastifyRequest) => run(req, { recording: false }),

    async version(req: FastifyRequest) {
      return { version: await getCorpusVersion(ctx, requireOwner(req)) };
    },
  };
}

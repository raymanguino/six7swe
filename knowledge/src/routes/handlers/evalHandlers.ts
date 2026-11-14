import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  EvalQuestionActionRequestSchema,
  EvalQuestionParamsSchema,
  type EvalQuestionResponse,
  type EvalRunAcceptedResponse,
  type EvalStateResponse,
} from '../../contract.js';
import { requireOwner } from '../../plugins/serviceAuth.js';
import type { KnowledgeContext } from '../context.js';
import { toEvalQuestionDto, toEvalRunDto } from '../mappers.js';

/** The owner's view of the evolving chat eval set (#85). */
export function evalHandlers(ctx: KnowledgeContext) {
  return {
    /** The questions (seeding the canned ones on first use), the latest run and its diff. */
    async state(req: FastifyRequest): Promise<EvalStateResponse> {
      const ownerId = requireOwner(req);
      await ctx.evalSet.ensureSeeded(ownerId);
      const [questions, latest] = await Promise.all([
        ctx.evalSet.list(ownerId),
        ctx.evalRepo.getLatestRun(ownerId),
      ]);
      const previous = latest
        ? await ctx.evalRepo.getPreviousCompletedRun(ownerId, latest.corpusVersion)
        : null;
      return {
        settings: { ...ctx.evalSet.settings, answering: ctx.evalRunner.answering },
        questions: questions.map(toEvalQuestionDto),
        latestRun: latest && toEvalRunDto(latest, previous),
        running: ctx.evalRunner.isRunning(ownerId),
      };
    },

    /** Queues a run of the active questions now (202). */
    async run(req: FastifyRequest, reply: FastifyReply) {
      ctx.evalRunner.request(requireOwner(req), 'manual');
      const body: EvalRunAcceptedResponse = { running: true };
      return reply.code(202).send(body);
    },

    /** Pin, unpin, retire, promote, or flag a question off-topic (or clear the flag). */
    async act(req: FastifyRequest): Promise<EvalQuestionResponse> {
      const ownerId = requireOwner(req);
      const { id } = EvalQuestionParamsSchema.parse(req.params);
      const { action } = EvalQuestionActionRequestSchema.parse(req.body);
      const { question, evicted } = await ctx.evalSet.act(ownerId, id, action);
      return {
        question: toEvalQuestionDto(question),
        evicted: evicted && toEvalQuestionDto(evicted),
      };
    },
  };
}

import { FastifyRequest, FastifyReply } from 'fastify';
import { INPUT_LIMITS } from '../../constants';
import { getChatContext } from '../../data/chatContext';
import { fitCheckWithContext } from '../../services/ai';
import { MiniMaxApiError } from '../../services/minimaxService';

export async function fitcheckHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { jobDescription } = request.body as { jobDescription: string };

    if (!jobDescription || typeof jobDescription !== 'string' || !jobDescription.trim()) {
      return reply.code(400).send({ error: 'Job description is required' });
    }
    const trimmed = jobDescription.trim();
    if (trimmed.length > INPUT_LIMITS.jobDescription) {
      return reply.code(400).send({ error: `Job description must be at most ${INPUT_LIMITS.jobDescription} characters` });
    }

    const rayContext = await getChatContext();

    const output = await fitCheckWithContext(trimmed, rayContext);

    return reply.code(200).send({
      snarkyPreamble: output.snarky_preamble,
      verdict: output.verdict,
      whereIMatch: output.where_i_match ?? [],
      gapsToNote: output.gaps_to_note ?? [],
      whereIDontFit: output.where_i_dont_fit ?? [],
      whatDoesTransfer: output.what_does_transfer ?? '',
      recommendation: output.recommendation,
    });
  } catch (error) {
    request.log.error({ err: error }, 'Error in FitCheck handler');
    if (error instanceof MiniMaxApiError) {
      return reply.code(502).send({ error: 'The AI service is temporarily unavailable. Please try again.' });
    }
    return reply.code(500).send({ error: 'Something went wrong while analyzing this job fit. Please try again.' });
  }
}
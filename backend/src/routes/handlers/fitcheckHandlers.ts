import { FastifyRequest, FastifyReply } from 'fastify';
import { run } from '@openai/agents';
import { INPUT_LIMITS } from '../../constants';
import { getChatContext } from '../../data/chatContext';
import { createFitCheckAgent } from '../../services/agents/agentDefinitions';
import { withPortfolioMcpServers } from '../../services/mcpAgentServer';

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

    const context = [
      rayContext,
      '',
      '---',
      '',
      'Job Description to analyze:',
      trimmed,
    ].join('\n');

    const result = await withPortfolioMcpServers(async (servers) => {
      const agent = createFitCheckAgent(servers);
      return run(agent, context);
    });

    if (!result.finalOutput) {
      return reply.code(500).send({ error: 'FitCheck analysis failed to produce output' });
    }

    const output = result.finalOutput as unknown as {
      snarky_preamble?: string | null;
      verdict: 'strong' | 'weak';
      where_i_match?: Array<{ heading: string; details: string }>;
      gaps_to_note?: Array<{ heading: string; details: string }>;
      where_i_dont_fit?: Array<{ heading: string; details: string }>;
      what_does_transfer?: string;
      recommendation: string;
    };

    return reply.code(200).send({
      snarkyPreamble: output.snarky_preamble ?? null,
      verdict: output.verdict,
      whereIMatch: output.where_i_match ?? [],
      gapsToNote: output.gaps_to_note ?? [],
      whereIDontFit: output.where_i_dont_fit ?? [],
      whatDoesTransfer: output.what_does_transfer ?? '',
      recommendation: output.recommendation,
    });
  } catch (error) {
    request.log.error(error, 'Error in FitCheck handler');
    return reply.code(500).send({ error: 'Failed to analyze job fit' });
  }
}

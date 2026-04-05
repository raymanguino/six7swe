import { FastifyRequest, FastifyReply } from 'fastify';
import { run } from '@openai/agents';
import { INPUT_LIMITS } from '../../constants';
import { getPortfolioData } from '../../services/portfolioService';
import { createJobMatchAgent } from '../../services/agents/agentDefinitions';
import { withPortfolioMcpServers } from '../../services/mcpAgentServer';

export async function jobMatchHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { jobDescription } = request.body as { jobDescription: string };

    if (!jobDescription || typeof jobDescription !== 'string' || !jobDescription.trim()) {
      return reply.code(400).send({ error: 'Job description is required' });
    }
    const trimmed = jobDescription.trim();
    if (trimmed.length > INPUT_LIMITS.jobDescription) {
      return reply.code(400).send({ error: `Job description must be at most ${INPUT_LIMITS.jobDescription} characters` });
    }

    const { profile } = await getPortfolioData();
    const context = profile
      ? [
          `Candidate Profile:`,
          `Name: ${profile.name}`,
          `Title: ${profile.title}`,
          `Summary: ${profile.summary}`,
          `Skills: ${profile.skills.join(', ')}`,
          `Full Resume: ${profile.fullResumeText}`,
          '',
          `Job Description:`,
          trimmed,
        ].join('\n')
      : [`Job Description:`, trimmed].join('\n');

    const result = await withPortfolioMcpServers(async (servers) => {
      const agent = createJobMatchAgent(servers);
      return run(agent, context);
    });

    let score = 75;
    let analysis = 'Based on the job description, there appears to be a reasonable match with the candidate\'s skills and experience.';

    if (result.finalOutput && typeof result.finalOutput === 'object') {
      const output = result.finalOutput as { score: number; analysis: string };
      score = output.score ?? score;
      analysis = output.analysis ?? analysis;
    }

    return reply.code(200).send({
      score: Math.round(score),
      analysis,
    });
  } catch (error) {
    request.log.error(error, 'Error in job match handler');
    return reply.code(500).send({ error: 'Failed to analyze job match' });
  }
}

import { FastifyRequest, FastifyReply } from 'fastify';
import { INPUT_LIMITS } from '../../constants';
import { getPortfolioData } from '../../services/portfolioService';
import { jobMatchWithContext, MiniMaxApiError } from '../../services/minimaxService';

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
    const profileContext = profile
      ? [
          `Name: ${profile.name}`,
          `Title: ${profile.title}`,
          `Summary: ${profile.summary}`,
          `Skills: ${profile.skills.join(', ')}`,
          `Full Resume: ${profile.fullResumeText}`,
        ].join('\n')
      : 'No profile data available.';

    const result = await jobMatchWithContext(trimmed, profileContext);

    return reply.code(200).send({
      score: Math.round(result.score),
      analysis: result.analysis,
    });
  } catch (error) {
    request.log.error({ err: error }, 'Error in job match handler');
    if (error instanceof MiniMaxApiError) {
      return reply.code(502).send({ error: 'The AI service is temporarily unavailable. Please try again.' });
    }
    return reply.code(500).send({ error: 'Something went wrong while analyzing this job match. Please try again.' });
  }
}
import { FastifyRequest, FastifyReply } from 'fastify';
import { INPUT_LIMITS } from '../../constants';
import { getPortfolioData } from '../../services/portfolioService';
import { matchJob } from '../../services/ai';
import { MiniMaxApiError } from '../../services/minimaxService';

/**
 * Public job matcher.
 *
 * Shares the canonical matcher with the job-hunter refresh pipeline, so a
 * job is scored the same way whether it arrives from a visitor or from a
 * scrape. Only the candidate context differs.
 */
export async function jobMatchHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { jobDescription } = request.body as { jobDescription: string };

    if (!jobDescription || typeof jobDescription !== 'string' || !jobDescription.trim()) {
      return reply.code(400).send({ error: 'Job description is required' });
    }
    const trimmed = jobDescription.trim();
    if (trimmed.length > INPUT_LIMITS.jobDescription) {
      return reply.code(400).send({
        error: `Job description must be at most ${INPUT_LIMITS.jobDescription} characters`,
      });
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

    const result = await matchJob({ jobDescription: trimmed, profileContext });

    return reply.code(200).send({
      score: result.score,
      analysis: result.analysis,
      band: result.band,
      matchedSkills: result.matchedSkills,
      gaps: result.gaps,
      summary: result.summary,
    });
  } catch (error) {
    request.log.error({ err: error }, 'Error in job match handler');
    if (error instanceof MiniMaxApiError) {
      return reply.code(502).send({
        error: 'The AI service is temporarily unavailable. Please try again.',
      });
    }
    return reply.code(500).send({
      error: 'Something went wrong while analyzing this job match. Please try again.',
    });
  }
}

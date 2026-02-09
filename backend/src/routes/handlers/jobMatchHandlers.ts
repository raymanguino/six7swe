import { FastifyRequest, FastifyReply } from 'fastify';
import { Agent, run } from '@openai/agents';
import { z } from 'zod';
import { INPUT_LIMITS } from '../../constants';
import { resumeData } from '../../data/resume';

const jobMatchAgent = new Agent({
  name: 'Job Match Analyzer',
  instructions: [
    'You are an expert at analyzing job descriptions and matching them to candidate profiles.',
    'Your task is to:',
    '1. Analyze the provided job description',
    '2. Compare it against Ray Manguino\'s skills and experience',
    '3. Provide a match score from 0-100',
    '4. Provide a brief analysis explaining the match',
    '',
    'Consider:',
    '- Required skills vs. candidate skills',
    '- Experience level requirements',
    '- Technology stack alignment',
    '- Domain/industry fit',
    '',
    'Be honest and accurate in your assessment.',
  ].join('\n'),
  outputType: z.object({
    score: z.number().min(0).max(100),
    analysis: z.string(),
  }),
});

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

    const context = [
      `Candidate Profile:`,
      `Name: ${resumeData.name}`,
      `Title: ${resumeData.title}`,
      `Summary: ${resumeData.summary}`,
      `Skills: ${resumeData.skills.join(', ')}`,
      `Full Resume: ${resumeData.fullResumeText}`,
      '',
      `Job Description:`,
      trimmed,
    ].join('\n');

    const result = await run(jobMatchAgent, context);
    
    // Get structured output from the agent
    let score = 75; // Default score
    let analysis = 'Based on the job description, there appears to be a reasonable match with the candidate\'s skills and experience.';

    if (result.finalOutput) {
      const output = result.finalOutput as { score: number; analysis: string };
      score = output.score ?? score;
      analysis = output.analysis ?? analysis;
    }

    return reply.code(200).send({ 
      score: Math.round(score),
      analysis 
    });
  } catch (error) {
    request.log.error(error, 'Error in job match handler');
    return reply.code(500).send({ error: 'Failed to analyze job match' });
  }
}

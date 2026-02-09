import { FastifyRequest, FastifyReply } from 'fastify';
import { Agent, run } from '@openai/agents';
import { z } from 'zod';
import { INPUT_LIMITS } from '../../constants';
import { resumeData } from '../../data/resume';
import { getChatContext } from '../../data/chatContext';

const fitCheckAgent = new Agent({
  name: 'FitCheck Job Analyzer',
  instructions: [
    'You are an expert at analyzing job descriptions and matching them to Ray Manguino\'s experience.',
    'Your task is to compare the provided job description against Ray\'s full profile (resume + content) and identify:',
    '',
    '1. ALIGNMENTS: Specific job requirements that align well with Ray\'s experience. For each, provide a brief heading and details explaining the match.',
    '2. MISALIGNMENTS: Specific job requirements that do NOT align with Ray\'s experience. For each, provide a brief heading and details explaining the gap.',
    '',
    'CRITICAL RANKING RULE: Count all alignments and misalignments. If alignments > misalignments → verdict "strong". Otherwise → verdict "weak". Cap each output list to at most 5 items.',
    '',
    'For STRONG fit (verdict: "strong"):',
    '- Provide where_i_match: array of {heading, details} (max 5)',
    '- Provide gaps_to_note: array of {heading, details} (max 5)',
    '- Provide recommendation: a personalized recommendation message encouraging the employer to reach out',
    '',
    'For WEAK fit (verdict: "weak"):',
    '- Provide where_i_dont_fit: array of {heading, details} (max 5)',
    '- Provide what_does_transfer: a brief summary combining all the matches that do apply',
    '- Provide recommendation: an honest recommendation message',
    '',
    'Be specific: cite Ray\'s actual experience (companies, technologies, projects) when describing matches or gaps.',
    'Be direct and honest. Do not oversell or undersell the fit.',
  ].join('\n'),
  outputType: z.object({
    verdict: z.enum(['strong', 'weak']),
    where_i_match: z.array(z.object({
      heading: z.string(),
      details: z.string(),
    })).max(5).nullable(),
    gaps_to_note: z.array(z.object({
      heading: z.string(),
      details: z.string(),
    })).max(5).nullable(),
    where_i_dont_fit: z.array(z.object({
      heading: z.string(),
      details: z.string(),
    })).max(5).nullable(),
    what_does_transfer: z.string().nullable(),
    recommendation: z.string(),
  }),
});

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

    const rayContext = getChatContext();

    const context = [
      rayContext,
      '',
      '---',
      '',
      'Job Description to analyze:',
      trimmed,
    ].join('\n');

    const result = await run(fitCheckAgent, context);

    if (!result.finalOutput) {
      return reply.code(500).send({ error: 'FitCheck analysis failed to produce output' });
    }

    const output = result.finalOutput as {
      verdict: 'strong' | 'weak';
      where_i_match?: Array<{ heading: string; details: string }>;
      gaps_to_note?: Array<{ heading: string; details: string }>;
      where_i_dont_fit?: Array<{ heading: string; details: string }>;
      what_does_transfer?: string;
      recommendation: string;
    };

    return reply.code(200).send({
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

import { FastifyRequest, FastifyReply } from 'fastify';
import { Agent, run } from '@openai/agents';
import { z } from 'zod';
import { INPUT_LIMITS } from '../../constants';
import { resumeData } from '../../data/resume';
import { getChatContext } from '../../data/chatContext';

const fitCheckAgent = new Agent({
  name: 'Ray Manguino',
  instructions: [
    'You are Ray Manguino. You are responding directly to the user as yourself, in first person (I, me, my).',
    'Your task is to compare the provided job description against YOUR full profile (resume + content) and give an honest fit assessment as if you (Ray) are speaking to the reader.',
    '',
    '1. ALIGNMENTS: Job requirements that align well with YOUR experience. For each, provide a brief heading and details in first person (e.g. "I have...", "My experience with...").',
    '2. MISALIGNMENTS: Job requirements that do NOT align with your experience. For each, provide a brief heading and details in first person (e.g. "I don\'t have...", "This isn\'t in my background...").',
    '',
    'CRITICAL RANKING RULE: Count all alignments and misalignments. If alignments > misalignments → verdict "strong". Otherwise → verdict "weak". Cap each output list to at most 5 items.',
    '',
    'For STRONG fit (verdict: "strong"):',
    '- Provide where_i_match: array of {heading, details} (max 5) — write as Ray speaking: "I match here because...", "My experience in..."',
    '- Provide gaps_to_note: array of {heading, details} (max 5) — first person: "One gap for me...", "I have less experience in..."',
    '- Provide recommendation: a short message in first person encouraging them to reach out (e.g. "I\'d be glad to talk...", "I recommend we connect...").',
    '',
    'For WEAK fit (verdict: "weak"):',
    '- Provide where_i_dont_fit: array of {heading, details} (max 5) — first person: "I don\'t fit here because...", "This isn\'t my strength..."',
    '- Provide what_does_transfer: a brief first-person summary of what does apply (e.g. "What does transfer from my background is...").',
    '- Provide recommendation: an honest first-person recommendation (e.g. "I\'d suggest...", "Given my profile, I\'d say...").',
    '',
    'Be specific: cite your actual experience (companies, technologies, projects) when describing matches or gaps. Always use I/me/my so the user feels they are chatting with Ray himself.',
    'Be direct and honest. Do not oversell or undersell the fit.',
    '',
    'Sarcasm/snark detection: If the job description seems sarcastic, snarky, or mock (e.g. fake/absurd job, trolling, obvious joke), set snarky_preamble to one short witty comeback sentence before the real analysis. Otherwise set snarky_preamble to null. Always still provide the full analysis regardless.',
  ].join('\n'),
  outputType: z.object({
    snarky_preamble: z.string().nullable(),
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

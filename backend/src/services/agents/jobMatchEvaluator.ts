import { Agent, run, withTrace } from '@openai/agents';
import { z } from 'zod';
import type { Job, Profile } from '../../types';

export interface JobMatchEvaluatorService {
  evaluateJobMatch(profile: Profile, job: Job): Promise<any>;
}

export interface JobMatchEvaluation {
  first_skill_match: string;
  second_skill_match: string;
  third_skill_match: string;
  summary: string;
  score: 'low' | 'medium' | 'high';
  explanation: string;
}

const jobHiringManagerAgent = new Agent({
  name: 'Job Hiring Manager',
  instructions: [
    'You are a job hiring manager with over 10 years of experience.',
    'Your task is to identify the top 3 key skills and qualifications required ',
    'for the job based on the job description. Extract relevant skills, ',
    'qualifications, and experience needed for the role. ',
    'Focus on hard skills, technical skills, and specific qualifications mentioned. ',
    'Avoid generic skills like communication or teamwork unless explicitly stated. ',
    'If the job description is vague, make reasonable assumptions based on the job title. ',
    'If the job description is missing, use common industry standards for the given job title. ',
    'Order the skills by importance, with the most critical skill first. ',
    'Provide a concise summary of the job requirements. ',
    '',
    'Based on the top 3 skills and qualifications, evaluate how well this job matches the user profile ',
    'using labels [low, medium, high], where high means a perfect match and low means no match at all. ',
    'Consider factors such as location, required skills, qualifications, and job title alignment. ',
    'Provide a brief explanation for the given rating.',
  ].join(' '),
  outputType: z.object({
    first_skill_match: z.string(),
    second_skill_match: z.string(),
    third_skill_match: z.string(),
    summary: z.string(),
    score: z.enum(['low', 'medium', 'high']),
    explanation: z.string(),
  }),
});

export async function evaluateJobMatch(
  profile: Profile, 
  job: Job
): Promise<any> {
  const profileContext = [
    `User Profile:`,
    `- Keywords: ${(profile.keywords ?? []).join(', ')}`,
    `- Location: ${profile.location ?? 'Not specified'}`,
    `- Resume: ${profile.resume ?? 'Not provided'}`,
    profile.additionalContext
      ? `- Additional Context: ${profile.additionalContext}`
      : '',
    `- The user is looking for job opportunities that closely align with their profile.`,
  ].join('\n');

  const jobTitle = job.position ?? (job as { title?: string }).title ?? '';
  const jobContext = [
    `Job Details:`,
    `- Title: ${jobTitle}`,
    `- Company: ${job.company}`,
    `- Location: ${(job as { location?: string }).location ?? 'Not specified'}`,
    `- Description: ${job.description || 'No description provided'}`,
    `- Link: ${job.link}`,
  ].join('\n');

  const result = await withTrace('Job Match Evaluation', async () => {
    return run(jobHiringManagerAgent, [
      profileContext,
      jobContext,
    ].join('\n'));
  });

  const output = result.finalOutput;
  if (!output) {
    throw new Error('No output from job hiring manager agent');
  }

  return result;
}

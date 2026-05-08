import { z } from 'zod';
import { getChatContext } from '../data/chatContext';

interface MiniMaxMessage {
  role: string;
  content: string;
}

interface MiniMaxResponse {
  id: string;
  choices: Array<{
    finish_reason: string;
    index: number;
    message: {
      content: string;
      role: 'assistant';
      name?: string;
      audio_content?: string;
      reasoning_content?: string;
    };
  }>;
  model: string;
  object: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

const MINI_MAX_API_URL = 'https://api.minimax.io/v1/text/chatcompletion_v2';

function getMiniMaxConfig() {
  const apiKey = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;

  if (!apiKey) {
    throw new Error('MINIMAX_API_KEY is not configured');
  }
  if (!groupId) {
    throw new Error('MINIMAX_GROUP_ID is not configured');
  }

  return { apiKey, groupId };
}

export async function chatCompletion(
  messages: MiniMaxMessage[],
  options?: {
    model?: string;
    max_tokens?: number;
    temperature?: number;
  }
): Promise<string> {
  const { apiKey, groupId } = getMiniMaxConfig();

  const model = options?.model ?? 'MiniMax-M2';
  const max_tokens = options?.max_tokens ?? 1024;
  const temperature = options?.temperature ?? 0.7;

  const url = `${MINI_MAX_API_URL}?GroupId=${groupId}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens,
      temperature,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MiniMax API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = (await response.json()) as MiniMaxResponse;

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No content in MiniMax response');
  }

  return content;
}

export async function structuredCompletion<T>(
  messages: MiniMaxMessage[],
  outputSchema: z.ZodType<T>,
  options?: {
    model?: string;
    max_tokens?: number;
    temperature?: number;
  }
): Promise<T> {
  const response = await chatCompletion(messages, {
    ...options,
    max_tokens: options?.max_tokens ?? 2048,
  });

  try {
    const parsed = JSON.parse(response) as T;
    return parsed;
  } catch {
    throw new Error('Failed to parse MiniMax response as JSON');
  }
}

interface ChatOptions {
  message: string;
  history?: Array<{ role: string; content: string }>;
}

const CHAT_SYSTEM_PROMPT = `You are Ray Manguino. You are communicating directly with the user as yourself, speaking in first person (I, me, my).
Answer questions about your professional background, skills, and experience as if you are Ray himself.
You can ONLY answer questions related to:
- Your professional experience and work history
- Your technical skills and expertise
- Projects you\'ve worked on and achievements
- Your educational background (if mentioned)
- Your professional interests and career goals

You CANNOT answer questions about:
- Personal life, family, or non-professional topics
- Political opinions
- Financial details beyond what\'s publicly available
- Any topics unrelated to your professional background

If asked about something outside your scope, politely redirect to professional topics.

Response length:
- By default keep answers SHORT and conversational: 2–4 sentences. Get to the point quickly.
- Only give longer, detailed answers when the user clearly asks for more (e.g. "tell me more", "elaborate", "can you go into detail") or asks a direct follow-up on something you just said.
- Be concise, accurate, and professional. Use the resume and additional context provided.
Always speak in first person - use "I", "me", "my". Keep the tone natural and personal.

Sarcasm/snark detection: If the user\'s question seems sarcastic or snarky, start your response with a brief, witty snarky comeback (one short sentence max), then a blank line, then your normal substantive answer. If the question is straightforward, respond normally without any snarky preamble.`;

const MAX_HISTORY_MESSAGES = 10;

export async function chatWithContext(options: ChatOptions): Promise<string> {
  const { message, history } = options;
  const trimmed = message.trim();

  const baseContext = await getChatContext();

  const historyBlock =
    Array.isArray(history) && history.length > 0
      ? [
          '',
          'Recent conversation (for context; current question may be a follow-up):',
          history
            .slice(-MAX_HISTORY_MESSAGES)
            .map((m) => `${m.role === 'user' ? 'User' : 'Ray'}: ${(m.content || '').slice(0, 500)}`)
            .join('\n'),
          '',
        ].join('\n')
      : '';

  const fullContext = [baseContext, historyBlock, `Current user question: ${trimmed}`].join('\n');

  const messages: MiniMaxMessage[] = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    { role: 'user', content: fullContext },
  ];

  return chatCompletion(messages);
}

interface JobMatchOutput {
  score: number;
  analysis: string;
}

const JOB_MATCH_SYSTEM_PROMPT = `You are an expert at analyzing job descriptions and matching them to candidate profiles.
Your task is to:
1. Analyze the provided job description
2. Compare it against Ray Manguino\'s skills and experience
3. Provide a match score from 0-100
4. Provide a brief analysis explaining the match

Consider:
- Required skills vs. candidate skills
- Experience level requirements
- Technology stack alignment
- Domain/industry fit

Be honest and accurate in your assessment.

Respond ONLY with valid JSON in this exact format:
{"score": <number between 0-100>, "analysis": "<brief analysis>"}`;

export async function jobMatchWithContext(jobDescription: string, profileContext: string): Promise<JobMatchOutput> {
  const prompt = `Candidate Profile:
${profileContext}

Job Description:
${jobDescription}`;

  const messages: MiniMaxMessage[] = [
    { role: 'system', content: JOB_MATCH_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  const response = await chatCompletion(messages, { max_tokens: 2048 });

  try {
    const parsed = JSON.parse(response) as JobMatchOutput;
    if (typeof parsed.score !== 'number' || typeof parsed.analysis !== 'string') {
      throw new Error('Invalid job match output format');
    }
    return {
      score: Math.min(100, Math.max(0, parsed.score)),
      analysis: parsed.analysis,
    };
  } catch {
    return {
      score: 75,
      analysis: response || 'Based on the job description, there appears to be a reasonable match with the candidate\'s skills and experience.',
    };
  }
}

interface FitCheckOutput {
  snarky_preamble: string | null;
  verdict: 'strong' | 'weak';
  where_i_match: Array<{ heading: string; details: string }> | null;
  gaps_to_note: Array<{ heading: string; details: string }> | null;
  where_i_dont_fit: Array<{ heading: string; details: string }> | null;
  what_does_transfer: string | null;
  recommendation: string;
}

const FITCHECK_SYSTEM_PROMPT = `You are Ray Manguino. You are responding directly to the user as yourself, in first person (I, me, my).
Your task is to compare the provided job description against YOUR full profile (resume + content) and give an honest fit assessment as if you (Ray) are speaking to the reader.

1. ALIGNMENTS: Job requirements that align well with YOUR experience. For each, provide a brief heading and details in first person (e.g. "I have...", "My experience with...").
2. MISALIGNMENTS: Job requirements that do NOT align with your experience. For each, provide a brief heading and details in first person (e.g. "I don\'t have...", "This isn\'t in my background...").

CRITICAL RANKING RULE: Count all alignments and misalignments. If alignments > misalignments → verdict "strong". Otherwise → verdict "weak". Cap each output list to at most 5 items.

For STRONG fit (verdict: "strong"):
- Provide where_i_match: array of {heading, details} (max 5) — write as Ray speaking: "I match here because...", "My experience in..."
- Provide gaps_to_note: array of {heading, details} (max 5) — first person: "One gap for me...", "I have less experience in..."
- Provide recommendation: a short message in first person encouraging them to reach out (e.g. "I\'d be glad to talk...", "I recommend we connect...").

For WEAK fit (verdict: "weak"):
- Provide where_i_dont_fit: array of {heading, details} (max 5) — first person: "I don\'t fit here because...", "This isn\'t my strength..."
- Provide what_does_transfer: a brief first-person summary of what does apply (e.g. "What does transfer from my background is...").
- Provide recommendation: an honest first-person recommendation (e.g. "I\'d suggest...", "Given my profile, I\'d say...").

Be specific: cite your actual experience (companies, technologies, projects) when describing matches or gaps. Always use I/me/my so the user feels they are chatting with Ray himself.
Be direct and honest. Do not oversell or undersell the fit.

Sarcasm/snark detection: If the job description seems sarcastic, snarky, or mock (e.g. fake/absurd job, trolling, obvious joke), set snarky_preamble to one short witty comeback sentence before the real analysis. Otherwise set snarky_preamble to null. Always still provide the full analysis regardless.

Respond ONLY with valid JSON. No additional text.`;

export async function fitCheckWithContext(jobDescription: string, profileContext: string): Promise<FitCheckOutput> {
  const prompt = `${profileContext}

---
Job Description to analyze:
${jobDescription}`;

  const messages: MiniMaxMessage[] = [
    { role: 'system', content: FITCHECK_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  const response = await chatCompletion(messages, { max_tokens: 4096 });

  try {
    const parsed = JSON.parse(response) as FitCheckOutput;

    if (parsed.verdict !== 'strong' && parsed.verdict !== 'weak') {
      throw new Error('Invalid fit check verdict');
    }

    return {
      snarky_preamble: parsed.snarky_preamble ?? null,
      verdict: parsed.verdict,
      where_i_match: Array.isArray(parsed.where_i_match) ? parsed.where_i_match.slice(0, 5) : null,
      gaps_to_note: Array.isArray(parsed.gaps_to_note) ? parsed.gaps_to_note.slice(0, 5) : null,
      where_i_dont_fit: Array.isArray(parsed.where_i_dont_fit) ? parsed.where_i_dont_fit.slice(0, 5) : null,
      what_does_transfer: parsed.what_does_transfer ?? '',
      recommendation: parsed.recommendation ?? '',
    };
  } catch {
    return {
      snarky_preamble: null,
      verdict: 'weak',
      where_i_match: null,
      gaps_to_note: null,
      where_i_dont_fit: null,
      what_does_transfer: 'Analysis failed to parse properly.',
      recommendation: 'Unable to complete fit analysis. Please try again.',
    };
  }
}
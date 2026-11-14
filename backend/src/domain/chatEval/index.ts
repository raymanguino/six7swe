import { z } from 'zod';

/**
 * The chat eval: canned questions answered twice, once with the stuffed
 * context (whole resume plus every content section) and once with the
 * retrieved context (profile summary plus top-k chunks), then compared by a
 * blind judge. Pure: no IO. `scripts/chat-eval.ts` runs it.
 *
 * The seed set is where the evolving eval set of the epic (#80) starts; real
 * visitor questions get promoted into it later.
 */

export interface EvalQuestion {
  id: string;
  question: string;
  /** Earlier turns, for questions that only make sense as a follow-up. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export const SEED_EVAL_QUESTIONS: readonly EvalQuestion[] = [
  { id: 'current-role', question: 'What do you do right now, and what does your role involve?' },
  {
    id: 'strongest-stack',
    question: 'Which programming languages and frameworks are you strongest in?',
  },
  {
    id: 'hardest-project',
    question: "Tell me about the most technically challenging project you've worked on.",
  },
  {
    id: 'distributed-systems',
    question: 'What experience do you have with distributed systems or scaling backends?',
  },
  {
    id: 'cloud-devops',
    question: 'Have you worked with cloud infrastructure, CI/CD or other DevOps tooling?',
  },
  { id: 'databases', question: 'Which databases have you used, and for what?' },
  { id: 'leadership', question: 'Have you led a team or mentored other engineers?' },
  { id: 'education', question: "What's your educational background?" },
  { id: 'next-role', question: 'What kind of role are you looking for next?' },
  {
    id: 'follow-up-proudest',
    history: [{ role: 'user', content: 'Tell me about your most recent job.' }],
    question: "What did you ship there that you're proudest of?",
  },
];

const score = z.number().int().min(1).max(5);

export const JudgeScoreSchema = z.object({
  accuracy: score,
  completeness: score,
  notes: z.string(),
});
export type JudgeScore = z.infer<typeof JudgeScoreSchema>;

export const JudgeVerdictSchema = z.object({
  answer_1: JudgeScoreSchema,
  answer_2: JudgeScoreSchema,
  preferred: z.enum(['1', '2', 'tie']),
  reason: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/**
 * The judge sees the full background as the reference, and the two answers
 * in an order that alternates per question, so it cannot learn which side is
 * which.
 */
export function buildJudgeMessages(input: {
  reference: string;
  question: EvalQuestion;
  answer1: string;
  answer2: string;
}): Array<{ role: string; content: string }> {
  const history = input.question.history?.length
    ? `Earlier conversation:\n${input.question.history
        .map((m) => `${m.role === 'user' ? 'User' : 'Ray'}: ${m.content}`)
        .join('\n')}\n\n`
    : '';
  return [
    {
      role: 'system',
      content: [
        'You grade answers from a portfolio chat assistant that speaks as Ray, a software engineer.',
        'The reference material below is the complete, authoritative record of his background.',
        'Score each answer from 1 to 5:',
        '- accuracy: every claim is supported by the reference; invented or wrong facts score low.',
        '- completeness: it covers what the reference says that matters for the question, at a sensible length (2-4 sentences is the target).',
        'Then say which answer is better overall, or "tie".',
        'Reply with JSON only, exactly this shape:',
        '{"answer_1":{"accuracy":1,"completeness":1,"notes":""},"answer_2":{"accuracy":1,"completeness":1,"notes":""},"preferred":"1"|"2"|"tie","reason":""}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Reference material:',
        input.reference,
        '',
        `${history}Question: ${input.question.question}`,
        '',
        `Answer 1:\n${input.answer1}`,
        '',
        `Answer 2:\n${input.answer2}`,
      ].join('\n'),
    },
  ];
}

export type Side = 'stuffed' | 'retrieved';

export interface EvalRow {
  question: EvalQuestion;
  stuffed: { answer: string; contextChars: number };
  retrieved: { answer: string; contextChars: number; chunkCount: number; mode: string };
  /** Which side the judge saw as answer 1. */
  firstSide: Side;
  verdict: JudgeVerdict | null;
  error?: string;
}

/** The judge's scores mapped back from answer 1 / answer 2 to the two sides. */
export function scoresBySide(
  row: Pick<EvalRow, 'firstSide' | 'verdict'>,
): { stuffed: JudgeScore; retrieved: JudgeScore; winner: Side | 'tie' } | null {
  if (!row.verdict) return null;
  const first = row.verdict.answer_1;
  const second = row.verdict.answer_2;
  const stuffedIsFirst = row.firstSide === 'stuffed';
  const winner =
    row.verdict.preferred === 'tie'
      ? 'tie'
      : (row.verdict.preferred === '1') === stuffedIsFirst
        ? 'stuffed'
        : 'retrieved';
  return {
    stuffed: stuffedIsFirst ? first : second,
    retrieved: stuffedIsFirst ? second : first,
    winner,
  };
}

const total = (s: JudgeScore) => s.accuracy + s.completeness;
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

export interface EvalSummary {
  judged: number;
  stuffedMean: number;
  retrievedMean: number;
  wins: number;
  ties: number;
  losses: number;
  /** The acceptance bar: retrieved scores at least as well as stuffed. */
  retrievedAtLeastAsGood: boolean;
}

export function summarizeEval(rows: EvalRow[]): EvalSummary {
  const judged = rows.map(scoresBySide).filter((s) => s !== null);
  const stuffedMean = mean(judged.map((s) => total(s.stuffed)));
  const retrievedMean = mean(judged.map((s) => total(s.retrieved)));
  return {
    judged: judged.length,
    stuffedMean,
    retrievedMean,
    wins: judged.filter((s) => s.winner === 'retrieved').length,
    ties: judged.filter((s) => s.winner === 'tie').length,
    losses: judged.filter((s) => s.winner === 'stuffed').length,
    retrievedAtLeastAsGood: judged.length === rows.length && retrievedMean >= stuffedMean,
  };
}

/** A Markdown report to attach to the PR. */
export function renderEvalReport(
  rows: EvalRow[],
  meta: { generatedAt: string; model: string },
): string {
  const summary = summarizeEval(rows);
  const lines: string[] = [
    '# Chat eval: stuffed vs retrieved context',
    '',
    `Generated ${meta.generatedAt} with ${meta.model}. Scores are accuracy + completeness (2-10), from a blind judge that saw the full stuffed context as the reference.`,
    '',
    `- Judged: ${summary.judged} of ${rows.length}`,
    `- Mean score: stuffed ${summary.stuffedMean.toFixed(2)}, retrieved ${summary.retrievedMean.toFixed(2)}`,
    `- Retrieved vs stuffed: ${summary.wins} wins, ${summary.ties} ties, ${summary.losses} losses`,
    `- Retrieved at least as good as stuffed: **${summary.retrievedAtLeastAsGood ? 'yes' : 'no'}**`,
    '',
    '| # | Question | Stuffed | Retrieved | Winner | Chunks | Context chars (stuffed / retrieved) |',
    '|---|---|---|---|---|---|---|',
  ];
  rows.forEach((row, i) => {
    const s = scoresBySide(row);
    lines.push(
      `| ${i + 1} | ${oneLine(row.question.question)} | ${s ? total(s.stuffed) : 'n/a'} | ${s ? total(s.retrieved) : 'n/a'} | ${s ? s.winner : `error: ${oneLine(row.error ?? 'not judged')}`} | ${row.retrieved.chunkCount} (${row.retrieved.mode}) | ${row.stuffed.contextChars} / ${row.retrieved.contextChars} |`,
    );
  });
  lines.push('', '## Answers', '');
  rows.forEach((row, i) => {
    const s = scoresBySide(row);
    lines.push(`### ${i + 1}. ${row.question.question}`, '');
    if (row.question.history?.length) {
      lines.push(
        `_Follow-up to: ${row.question.history.map((m) => `"${m.content}"`).join(', ')}_`,
        '',
      );
    }
    lines.push(
      '**Stuffed**',
      '',
      row.stuffed.answer,
      '',
      '**Retrieved**',
      '',
      row.retrieved.answer,
      '',
    );
    if (s && row.verdict) {
      lines.push(
        `**Judge:** winner ${s.winner}. ${row.verdict.reason}`,
        '',
        `- Stuffed: accuracy ${s.stuffed.accuracy}, completeness ${s.stuffed.completeness}. ${s.stuffed.notes}`,
        `- Retrieved: accuracy ${s.retrieved.accuracy}, completeness ${s.retrieved.completeness}. ${s.retrieved.notes}`,
        '',
      );
    } else if (row.error) {
      lines.push(`**Error:** ${row.error}`, '');
    }
  });
  return lines.join('\n');
}

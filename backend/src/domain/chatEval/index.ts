import type { DocumentDto } from '@six7swe/knowledge-types';
import { z } from 'zod';
import type { KnowledgeChatContext } from '../../data/chatContext';

/**
 * The chat eval: canned questions answered twice, once with the stuffed
 * context (whole resume plus every content section) and once with the
 * retrieved context (profile summary plus top-k chunks), then compared by a
 * blind judge. No IO of its own: the knowledge documents for the judge's
 * reference come through an injected source. `scripts/chat-eval.ts` runs it.
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

/** Reads the knowledge service's documents, for the judge's reference. */
export interface KnowledgeDocumentSource {
  listDocuments(): Promise<DocumentDto[]>;
  /** The extracted text, or null when no ingest has extracted it yet. */
  getDocumentText(documentId: string): Promise<string | null>;
}

export const STUFFED_CONTEXT_LABEL = 'Stuffed context';

export interface ReferenceSourceSummary {
  label: string;
  chars: number;
}

/** What the judge was given as the reference, and what the report says about it. */
export interface JudgeReferenceSummary {
  sources: ReferenceSourceSummary[];
  /**
   * Why the reference holds the stuffed context only, or null when it also
   * holds the knowledge documents. A stuffed-only reference does not include
   * the resume PDF, so the judge may score real resume facts as invented.
   */
  stuffedOnlyReason: string | null;
  /** Ready documents left out because they have no extracted text. */
  skipped: string[];
}

export interface JudgeReference extends JudgeReferenceSummary {
  text: string;
}

export function knowledgeDocumentLabel(doc: Pick<DocumentDto, 'filename' | 'kind'>): string {
  return `Knowledge document: ${doc.filename} (${doc.kind})`;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The judge's reference: the stuffed context plus the extracted text of every
 * ready knowledge document, each under its own label. The stuffed context
 * (the portfolio tables) does not hold the resume PDF, so judging against it
 * alone scores real resume facts as invented.
 *
 * Without a document source, or if any fetch fails, the reference falls back
 * to the stuffed context alone and `stuffedOnlyReason` says why. A partial set
 * of documents is never used: it would bias the judge without saying so.
 */
export async function buildJudgeReference(input: {
  stuffedContext: string;
  /** Null when the owner key is not configured. */
  documents: KnowledgeDocumentSource | null;
}): Promise<JudgeReference> {
  const stuffed = { label: STUFFED_CONTEXT_LABEL, text: input.stuffedContext.trim() };
  const stuffedOnly = (reason: string, skipped: string[] = []): JudgeReference => ({
    text: renderReference([stuffed]),
    sources: [{ label: stuffed.label, chars: stuffed.text.length }],
    stuffedOnlyReason: reason,
    skipped,
  });

  if (!input.documents) {
    return stuffedOnly('no knowledge-service owner key (KNOWLEDGE_OWNER_KEY) is configured');
  }
  const source = input.documents;

  let documents: Array<{ label: string; text: string }>;
  try {
    const ready = (await source.listDocuments()).filter((doc) => doc.status === 'ready');
    documents = await Promise.all(
      ready.map(async (doc) => ({
        label: knowledgeDocumentLabel(doc),
        text: ((await source.getDocumentText(doc.id)) ?? '').trim(),
      })),
    );
  } catch (error) {
    return stuffedOnly(`fetching the knowledge documents failed: ${errorMessage(error)}`);
  }

  const withText = documents.filter((doc) => doc.text.length > 0);
  const skipped = documents.filter((doc) => doc.text.length === 0).map((doc) => doc.label);
  if (withText.length === 0) {
    return stuffedOnly('the knowledge service has no ready documents with extracted text', skipped);
  }

  const all = [stuffed, ...withText];
  return {
    text: renderReference(all),
    sources: all.map((s) => ({ label: s.label, chars: s.text.length })),
    stuffedOnlyReason: null,
    skipped,
  };
}

function renderReference(sources: Array<{ label: string; text: string }>): string {
  return sources.map((s) => `===== ${s.label} =====\n${s.text}`).join('\n\n');
}

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
        'It is made of several labeled sources (such as the stuffed context and knowledge documents like his resume). All of them are authoritative: a claim supported by any one source is supported, and sources may overlap or word things differently.',
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

/** How the retrieved side's context was built, from `getKnowledgeChatContext`. */
export type RetrievalOutcome =
  | { mode: Extract<KnowledgeChatContext, { mode: 'retrieved' }>['mode'] }
  | Pick<Extract<KnowledgeChatContext, { mode: 'profile-only' }>, 'mode' | 'reason'>;

export interface EvalRow {
  question: EvalQuestion;
  /** Null when generating that answer failed (see `error`). */
  stuffed: { answer: string | null; contextChars: number };
  retrieved: {
    answer: string | null;
    contextChars: number;
    chunkCount: number;
    outcome: RetrievalOutcome | null;
  };
  /** Which side the judge saw as answer 1. */
  firstSide: Side;
  verdict: JudgeVerdict | null;
  error?: string;
}

/**
 * The retrieved side fell back to the profile because the service failed. Its
 * answer measures an outage, not retrieval, so it is not scored as retrieved.
 */
export function retrievalUnavailable(row: Pick<EvalRow, 'retrieved'>): boolean {
  const outcome = row.retrieved.outcome;
  return outcome?.mode === 'profile-only' && outcome.reason === 'unavailable';
}

function describeOutcome(outcome: RetrievalOutcome | null): string {
  if (!outcome) return 'n/a';
  return outcome.mode === 'retrieved' ? 'retrieved' : `profile-only, ${outcome.reason}`;
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
  /** Rows that count: judged, with retrieval actually available. */
  judged: number;
  /** Rows whose retrieved side fell back because the service was unavailable. */
  unavailable: number;
  /** Rows that failed (answer generation or judging) and were not judged. */
  failed: number;
  stuffedMean: number;
  retrievedMean: number;
  wins: number;
  ties: number;
  losses: number;
  /**
   * The acceptance bar: every question judged with retrieval available, and
   * retrieved scoring at least as well as stuffed on average.
   */
  retrievedAtLeastAsGood: boolean;
}

export function summarizeEval(rows: EvalRow[]): EvalSummary {
  const unavailable = rows.filter(retrievalUnavailable).length;
  const scored = rows
    .filter((row) => !retrievalUnavailable(row))
    .map(scoresBySide)
    .filter((s) => s !== null);
  const failed = rows.filter((row) => !retrievalUnavailable(row) && !row.verdict).length;
  const stuffedMean = mean(scored.map((s) => total(s.stuffed)));
  const retrievedMean = mean(scored.map((s) => total(s.retrieved)));
  return {
    judged: scored.length,
    unavailable,
    failed,
    stuffedMean,
    retrievedMean,
    wins: scored.filter((s) => s.winner === 'retrieved').length,
    ties: scored.filter((s) => s.winner === 'tie').length,
    losses: scored.filter((s) => s.winner === 'stuffed').length,
    retrievedAtLeastAsGood:
      rows.length > 0 && scored.length === rows.length && retrievedMean >= stuffedMean,
  };
}

/** A Markdown report to attach to the PR. */
export function renderEvalReport(
  rows: EvalRow[],
  meta: { generatedAt: string; model: string; reference: JudgeReferenceSummary },
): string {
  const summary = summarizeEval(rows);
  const { reference } = meta;
  const referenceChars = reference.sources.reduce((sum, s) => sum + s.chars, 0);
  const lines: string[] = [
    '# Chat eval: stuffed vs retrieved context',
    '',
    `Generated ${meta.generatedAt} with ${meta.model}. Scores are accuracy + completeness (2-10), from a blind judge that saw the reference below.`,
    '',
  ];
  if (reference.stuffedOnlyReason) {
    lines.push(
      `> **Warning: the judge's reference is the stuffed context only** (${reference.stuffedOnlyReason}). It does not include the knowledge documents, such as the resume PDF, so answers that cite facts found only there may be scored as invented.`,
      '',
    );
  }
  lines.push(
    `- Judge reference (${reference.sources.length} source(s), ${referenceChars} chars): ${reference.sources
      .map((s) => `${s.label} (${s.chars} chars)`)
      .join('; ')}`,
  );
  if (reference.skipped.length > 0) {
    lines.push(`- Left out of the reference (no extracted text): ${reference.skipped.join('; ')}`);
  }
  lines.push(`- Judged: ${summary.judged} of ${rows.length}`);
  if (summary.unavailable > 0) {
    lines.push(
      `- **Knowledge service unavailable for ${summary.unavailable} question(s):** those answers fell back to the profile only and are excluded from the scores below.`,
    );
  }
  if (summary.failed > 0) {
    lines.push(`- **Failed (not judged): ${summary.failed} question(s).** See the errors below.`);
  }
  lines.push(
    `- Mean score: stuffed ${summary.stuffedMean.toFixed(2)}, retrieved ${summary.retrievedMean.toFixed(2)}`,
    `- Retrieved vs stuffed: ${summary.wins} wins, ${summary.ties} ties, ${summary.losses} losses`,
    `- Retrieved at least as good as stuffed: **${summary.retrievedAtLeastAsGood ? 'yes' : 'no'}**${
      summary.retrievedAtLeastAsGood || summary.judged === rows.length
        ? ''
        : ' (not every question was judged with retrieval available)'
    }`,
    '',
    '| # | Question | Stuffed | Retrieved | Winner | Retrieval | Context chars (stuffed / retrieved) |',
    '|---|---|---|---|---|---|---|',
  );
  rows.forEach((row, i) => {
    const unavailable = retrievalUnavailable(row);
    const s = unavailable ? null : scoresBySide(row);
    const winner = unavailable
      ? 'excluded: service unavailable'
      : s
        ? s.winner
        : `error: ${oneLine(row.error ?? 'not judged')}`;
    lines.push(
      `| ${i + 1} | ${oneLine(row.question.question)} | ${s ? total(s.stuffed) : 'n/a'} | ${s ? total(s.retrieved) : 'n/a'} | ${winner} | ${row.retrieved.chunkCount} chunks (${describeOutcome(row.retrieved.outcome)}) | ${row.stuffed.contextChars} / ${row.retrieved.contextChars} |`,
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
    if (retrievalUnavailable(row)) {
      lines.push(
        '_The knowledge service was unavailable; the retrieved answer used the profile only._',
        '',
      );
    }
    lines.push(
      '**Stuffed**',
      '',
      row.stuffed.answer ?? '_(no answer)_',
      '',
      '**Retrieved**',
      '',
      row.retrieved.answer ?? '_(no answer)_',
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
    }
    if (row.error) {
      lines.push(`**Error:** ${row.error}`, '');
    }
  });
  return lines.join('\n');
}

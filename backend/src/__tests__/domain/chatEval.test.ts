import {
  JudgeVerdictSchema,
  SEED_EVAL_QUESTIONS,
  buildJudgeMessages,
  renderEvalReport,
  scoresBySide,
  summarizeEval,
  type EvalRow,
  type JudgeVerdict,
} from '../../domain/chatEval';

const verdict = (a1: number, a2: number, preferred: JudgeVerdict['preferred']): JudgeVerdict => ({
  answer_1: { accuracy: a1, completeness: a1, notes: '' },
  answer_2: { accuracy: a2, completeness: a2, notes: '' },
  preferred,
  reason: 'because',
});

const row = (firstSide: EvalRow['firstSide'], v: JudgeVerdict | null): EvalRow => ({
  question: { id: 'q', question: 'Q?' },
  stuffed: { answer: 'S', contextChars: 1000 },
  retrieved: { answer: 'R', contextChars: 300, chunkCount: 4, mode: 'retrieved' },
  firstSide,
  verdict: v,
});

describe('chat eval', () => {
  it('seeds 10 questions with unique ids', () => {
    expect(SEED_EVAL_QUESTIONS).toHaveLength(10);
    expect(new Set(SEED_EVAL_QUESTIONS.map((q) => q.id)).size).toBe(10);
  });

  it('maps the blind answer order back to the two sides', () => {
    expect(scoresBySide(row('stuffed', verdict(3, 5, '2')))).toMatchObject({
      stuffed: { accuracy: 3 },
      retrieved: { accuracy: 5 },
      winner: 'retrieved',
    });
    expect(scoresBySide(row('retrieved', verdict(3, 5, '2')))).toMatchObject({
      stuffed: { accuracy: 5 },
      retrieved: { accuracy: 3 },
      winner: 'stuffed',
    });
    expect(scoresBySide(row('retrieved', verdict(4, 4, 'tie')))?.winner).toBe('tie');
    expect(scoresBySide(row('stuffed', null))).toBeNull();
  });

  it('passes only when every question was judged and retrieved is at least as good', () => {
    const even = summarizeEval([
      row('stuffed', verdict(4, 4, 'tie')),
      row('retrieved', verdict(5, 3, '1')),
    ]);
    expect(even).toMatchObject({
      judged: 2,
      wins: 1,
      ties: 1,
      losses: 0,
      retrievedAtLeastAsGood: true,
    });

    const worse = summarizeEval([row('stuffed', verdict(5, 2, '1'))]);
    expect(worse.retrievedAtLeastAsGood).toBe(false);

    const missing = summarizeEval([row('stuffed', verdict(4, 4, 'tie')), row('stuffed', null)]);
    expect(missing.retrievedAtLeastAsGood).toBe(false);
  });

  it('renders a report with a summary and every answer', () => {
    const report = renderEvalReport([row('stuffed', verdict(4, 5, '2'))], {
      generatedAt: '2026-11-13T00:00:00Z',
      model: 'test',
    });
    expect(report).toContain('Mean score: stuffed 8.00, retrieved 10.00');
    expect(report).toContain('| 1 | Q? | 8 | 10 | retrieved | 4 (retrieved) | 1000 / 300 |');
    expect(report).toContain('**Retrieved**');
  });

  it('gives the judge the reference, the follow-up history and both answers', () => {
    const question = SEED_EVAL_QUESTIONS.find((q) => q.history);
    expect(question).toBeDefined();
    const [, user] = buildJudgeMessages({
      reference: 'REF',
      question: question!,
      answer1: 'A1',
      answer2: 'A2',
    });
    expect(user?.content).toContain('REF');
    expect(user?.content).toContain('Earlier conversation:');
    expect(user?.content).toContain('Answer 1:\nA1');
  });

  it('rejects an out-of-range judge score', () => {
    expect(JudgeVerdictSchema.safeParse(verdict(6, 1, '1')).success).toBe(false);
  });
});

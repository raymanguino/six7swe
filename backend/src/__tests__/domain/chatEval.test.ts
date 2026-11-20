import type { DocumentDto } from '@six7swe/knowledge-types';
import {
  JudgeVerdictSchema,
  SEED_EVAL_QUESTIONS,
  buildCorpusContext,
  buildJudgeMessages,
  renderEvalReport,
  scoresBySide,
  summarizeEval,
  type CorpusSummary,
  type EvalRow,
  type JudgeVerdict,
  type KnowledgeDocumentSource,
} from '../../domain/chatEval';

const fullReference: CorpusSummary = {
  sources: [
    { label: 'Knowledge document: resume.pdf (resume)', chars: 1000 },
    { label: 'Knowledge document: notes.md (supporting)', chars: 500 },
  ],
  skipped: [],
};
const meta = (reference: CorpusSummary = fullReference) => ({
  generatedAt: '2026-11-13T00:00:00Z',
  model: 'test',
  reference,
});

let docSeq = 0;
const doc = (overrides: Partial<DocumentDto> = {}): DocumentDto => {
  docSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(docSeq).padStart(12, '0')}`,
    filename: `doc-${docSeq}.md`,
    mimeType: 'text/markdown',
    sizeBytes: 10,
    kind: 'supporting',
    isPrimaryResume: false,
    status: 'ready',
    error: null,
    chunkCount: 1,
    findingCount: 0,
    scannedAt: null,
    approvedAt: null,
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
    ...overrides,
  };
};

function fakeDocuments(
  docs: DocumentDto[],
  texts: Record<string, string | null | Error>,
): KnowledgeDocumentSource & { getDocumentText: jest.Mock } {
  return {
    listDocuments: async () => docs,
    getDocumentText: jest.fn(async (id: string) => {
      const text = texts[id];
      if (text instanceof Error) throw text;
      return text ?? null;
    }),
  };
}

const verdict = (a1: number, a2: number, preferred: JudgeVerdict['preferred']): JudgeVerdict => ({
  answer_1: { accuracy: a1, completeness: a1, notes: '' },
  answer_2: { accuracy: a2, completeness: a2, notes: '' },
  preferred,
  reason: 'because',
});

const row = (firstSide: EvalRow['firstSide'], v: JudgeVerdict | null): EvalRow => ({
  question: { id: 'q', question: 'Q?' },
  stuffed: { answer: 'S', contextChars: 1000 },
  retrieved: { answer: 'R', contextChars: 300, chunkCount: 4, outcome: { mode: 'retrieved' } },
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
    const report = renderEvalReport([row('stuffed', verdict(4, 5, '2'))], meta());
    expect(report).toContain('Mean score: stuffed 8.00, retrieved 10.00');
    expect(report).toContain('| 1 | Q? | 8 | 10 | retrieved | 4 chunks (retrieved) | 1000 / 300 |');
    expect(report).toContain('**Retrieved**');
  });

  it('excludes rows where the knowledge service was unavailable, and says so', () => {
    const fellBack: EvalRow = {
      ...row('stuffed', verdict(2, 5, '2')),
      retrieved: {
        answer: 'R',
        contextChars: 100,
        chunkCount: 0,
        outcome: { mode: 'no-background', reason: 'unavailable' },
      },
    };
    const rows = [row('stuffed', verdict(4, 4, 'tie')), fellBack];

    const summary = summarizeEval(rows);
    expect(summary).toMatchObject({ judged: 1, unavailable: 1, wins: 0, ties: 1 });
    expect(summary.retrievedAtLeastAsGood).toBe(false);

    const report = renderEvalReport(rows, meta());
    expect(report).toContain('Knowledge service unavailable for 1 question(s)');
    expect(report).toContain('excluded: service unavailable');
    expect(report).toContain('(not every question was judged with retrieval available)');
  });

  it('counts a no-match fallback as a real retrieved result', () => {
    const noMatch: EvalRow = {
      ...row('stuffed', verdict(4, 4, 'tie')),
      retrieved: {
        answer: 'R',
        contextChars: 100,
        chunkCount: 0,
        outcome: { mode: 'no-background', reason: 'no-match' },
      },
    };
    expect(summarizeEval([noMatch])).toMatchObject({ judged: 1, unavailable: 0 });
  });

  it('reports a row whose answers failed without judging it', () => {
    const failed: EvalRow = {
      ...row('stuffed', null),
      stuffed: { answer: null, contextChars: 1000 },
      error: 'stuffed answer: MiniMax did not respond',
    };
    const summary = summarizeEval([failed]);
    expect(summary).toMatchObject({ judged: 0, failed: 1, retrievedAtLeastAsGood: false });
    const report = renderEvalReport([failed], meta());
    expect(report).toContain('**Error:** stuffed answer: MiniMax did not respond');
    expect(report).toContain('_(no answer)_');
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

  it('tells the judge that every labeled source is authoritative', () => {
    const [system] = buildJudgeMessages({
      reference: 'REF',
      question: SEED_EVAL_QUESTIONS[0]!,
      answer1: 'A1',
      answer2: 'A2',
    });
    expect(system?.content).toContain('All of them are authoritative');
  });

  it('rejects an out-of-range judge score', () => {
    expect(JudgeVerdictSchema.safeParse(verdict(6, 1, '1')).success).toBe(false);
  });
});

describe('buildCorpusContext', () => {
  it('labels every ready document with text, and fetches only ready ones', async () => {
    const resume = doc({ filename: 'resume.pdf', kind: 'resume' });
    const notes = doc({ filename: 'notes.md' });
    const pending = doc({ filename: 'pending.md', status: 'pending' });
    const failed = doc({ filename: 'failed.md', status: 'failed' });
    const source = fakeDocuments([resume, notes, pending, failed], {
      [resume.id]: 'Terraform and Kubernetes',
      [notes.id]: '  pgvector  ',
    });

    const corpus = await buildCorpusContext(source);

    expect(corpus.skipped).toEqual([]);
    expect(corpus.sources).toEqual([
      { label: 'Knowledge document: resume.pdf (resume)', chars: 24 },
      { label: 'Knowledge document: notes.md (supporting)', chars: 8 },
    ]);
    expect(corpus.text).toBe(
      [
        '===== Knowledge document: resume.pdf (resume) =====\nTerraform and Kubernetes',
        '===== Knowledge document: notes.md (supporting) =====\npgvector',
      ].join('\n\n'),
    );
    expect(source.getDocumentText.mock.calls.map(([id]) => id)).toEqual([resume.id, notes.id]);
  });

  it('lists ready documents without extracted text as skipped', async () => {
    const resume = doc({ filename: 'resume.pdf', kind: 'resume' });
    const empty = doc({ filename: 'empty.md' });
    const corpus = await buildCorpusContext(
      fakeDocuments([resume, empty], { [resume.id]: 'R', [empty.id]: null }),
    );
    expect(corpus.sources.map((s) => s.label)).toEqual(['Knowledge document: resume.pdf (resume)']);
    expect(corpus.skipped).toEqual(['Knowledge document: empty.md (supporting)']);
  });

  it('fails rather than use a partial corpus', async () => {
    const a = doc();
    const b = doc();
    await expect(
      buildCorpusContext(fakeDocuments([a, b], { [a.id]: 'A', [b.id]: new Error('timed out') })),
    ).rejects.toThrow('timed out');
    await expect(
      buildCorpusContext({
        listDocuments: async () => {
          throw new Error('Knowledge service /documents answered 401');
        },
        getDocumentText: async () => 'never',
      }),
    ).rejects.toThrow('answered 401');
  });

  it('fails when no ready document has text', async () => {
    await expect(
      buildCorpusContext(fakeDocuments([doc({ status: 'processing' })], {})),
    ).rejects.toThrow('the knowledge service has no ready documents with extracted text');
  });
});

describe('renderEvalReport corpus header', () => {
  it('states the sources and their character counts', () => {
    const report = renderEvalReport([row('stuffed', verdict(4, 4, 'tie'))], meta());
    expect(report).toContain(
      "- Corpus, the stuffed context and the judge's reference (2 source(s), 1500 chars): Knowledge document: resume.pdf (resume) (1000 chars); Knowledge document: notes.md (supporting) (500 chars)",
    );
  });

  it('lists documents left out of the corpus', () => {
    const report = renderEvalReport(
      [row('stuffed', verdict(4, 4, 'tie'))],
      meta({ ...fullReference, skipped: ['Knowledge document: empty.md (supporting)'] }),
    );
    expect(report).toContain(
      '- Left out of the corpus (no extracted text): Knowledge document: empty.md (supporting)',
    );
  });
});

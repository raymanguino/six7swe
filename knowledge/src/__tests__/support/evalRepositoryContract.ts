import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EvalRepository } from '../../db/api/evalRepository.js';
import { EMBEDDING_DIMENSIONS } from '../../db/schema.js';
import { hashEmbed } from '../../services/embedding/hashing.js';

export interface EvalContractTarget {
  evalRepo: EvalRepository;
  /** A fresh owner id for one test, so no test sees another's rows. */
  newOwner: () => string;
}

const embed = (text: string) => hashEmbed(text, EMBEDDING_DIMENSIONS);
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 0, minute));

/**
 * The behaviour every EvalRepository must have, run against the in-memory
 * double (always) and the Drizzle repository (with a database).
 */
export function describeEvalRepositoryContract(
  name: string,
  target: () => EvalContractTarget,
  options: { skip?: boolean } = {},
): void {
  describe.skipIf(options.skip ?? false)(`EvalRepository contract: ${name}`, () => {
    async function seeded(count: number) {
      const { evalRepo, newOwner } = target();
      const owner = newOwner();
      const canned = Array.from({ length: count }, (_, i) => ({
        question: `canned question number ${i}`,
        embedding: embed(`canned question number ${i}`),
      }));
      expect(await evalRepo.seedIfEmpty(owner, canned, at(0))).toBe(true);
      return { evalRepo, owner, questions: await evalRepo.listQuestions(owner) };
    }

    it('seeds the canned questions once, as active', async () => {
      const { evalRepo, owner, questions } = await seeded(3);
      expect(questions).toHaveLength(3);
      expect(questions.every((q) => q.status === 'active' && q.origin === 'canned')).toBe(true);
      expect(
        await evalRepo.seedIfEmpty(owner, [{ question: 'x', embedding: embed('x') }], at(1)),
      ).toBe(false);
      expect(await evalRepo.listQuestions(owner)).toHaveLength(3);
    });

    it('finds the nearest question, and nothing for an empty owner', async () => {
      const { evalRepo, newOwner } = target();
      expect(await evalRepo.nearestQuestion(newOwner(), embed('anything'))).toBeNull();

      const { owner } = await seeded(3);
      const nearest = await evalRepo.nearestQuestion(owner, embed('canned question number 1'));
      expect(nearest?.question.question).toBe('canned question number 1');
      expect(nearest?.similarity).toBeCloseTo(1, 5);
    });

    it('counts asks and distinct sessions, and never moves last_asked_at back', async () => {
      const { evalRepo, newOwner } = target();
      const owner = newOwner();
      const created = await evalRepo.createCandidate({
        ownerId: owner,
        question: 'Do you know Rust?',
        embedding: embed('Do you know Rust?'),
        offTopic: false,
        sessionHash: 'a'.repeat(64),
        now: at(10),
      });
      expect(created).toMatchObject({
        status: 'candidate',
        origin: 'visitor',
        hitCount: 1,
        distinctSessions: 1,
        pinned: false,
      });

      const same = await evalRepo.recordAsk(created.id, 'a'.repeat(64), at(11));
      expect(same).toMatchObject({ hitCount: 2, distinctSessions: 1 });
      const other = await evalRepo.recordAsk(created.id, 'b'.repeat(64), at(5));
      expect(other).toMatchObject({ hitCount: 3, distinctSessions: 2 });
      expect(other?.lastAskedAt.getTime()).toBe(at(11).getTime());
      expect(await evalRepo.recordAsk(randomUUID(), 'a'.repeat(64), at(12))).toBeNull();
    });

    it('promotes, retiring the least recently asked unpinned question when full', async () => {
      const { evalRepo, owner, questions } = await seeded(3);
      const [q0, q1, q2] = questions.sort((a, b) => a.question.localeCompare(b.question));
      if (!q0 || !q1 || !q2) throw new Error('not seeded');
      // q0 asked last, q1 pinned: q2 is the one to go.
      await evalRepo.recordAsk(q0.id, 'c'.repeat(64), at(30));
      await evalRepo.recordAsk(q2.id, 'c'.repeat(64), at(20));
      await evalRepo.recordAsk(q1.id, 'c'.repeat(64), at(1));
      await evalRepo.updateQuestion(owner, q1.id, { pinned: true });

      const candidate = await evalRepo.createCandidate({
        ownerId: owner,
        question: 'new one',
        embedding: embed('new one'),
        offTopic: true,
        sessionHash: 'd'.repeat(64),
        now: at(40),
      });
      const outcome = await evalRepo.promote(owner, candidate.id, 3);
      expect(outcome.status).toBe('promoted');
      if (outcome.status !== 'promoted') return;
      expect(outcome.question).toMatchObject({ status: 'active', offTopic: false });
      expect(outcome.evicted?.id).toBe(q2.id);
      expect(outcome.evicted?.status).toBe('retired');

      // Promoting an active question changes nothing.
      const again = await evalRepo.promote(owner, candidate.id, 3);
      expect(again).toMatchObject({ status: 'promoted', evicted: null });

      // Room left: no eviction.
      const roomy = await evalRepo.promote(owner, q2.id, 4);
      expect(roomy).toMatchObject({ status: 'promoted', evicted: null });

      expect(await evalRepo.promote('someone-else', q2.id, 4)).toEqual({ status: 'not-found' });
    });

    it('refuses to promote when every active question is pinned', async () => {
      const { evalRepo, owner, questions } = await seeded(2);
      for (const q of questions) await evalRepo.updateQuestion(owner, q.id, { pinned: true });
      const candidate = await evalRepo.createCandidate({
        ownerId: owner,
        question: 'waiting',
        embedding: embed('waiting'),
        offTopic: false,
        sessionHash: 'e'.repeat(64),
        now: at(5),
      });
      expect(await evalRepo.promote(owner, candidate.id, 2)).toEqual({ status: 'full' });
      expect((await evalRepo.getQuestion(owner, candidate.id))?.status).toBe('candidate');
    });

    it('scopes updates and reads to the owner, and lists active first', async () => {
      const { evalRepo, owner, questions } = await seeded(2);
      const first = questions[0];
      if (!first) throw new Error('not seeded');
      expect(await evalRepo.updateQuestion('someone-else', first.id, { pinned: true })).toBeNull();
      expect(await evalRepo.getQuestion('someone-else', first.id)).toBeNull();

      await evalRepo.updateQuestion(owner, first.id, { status: 'retired' });
      await evalRepo.createCandidate({
        ownerId: owner,
        question: 'candidate',
        embedding: embed('candidate'),
        offTopic: false,
        sessionHash: 'f'.repeat(64),
        now: at(50),
      });
      const statuses = (await evalRepo.listQuestions(owner)).map((q) => q.status);
      expect(statuses).toEqual(['active', 'candidate', 'retired']);
      const active = await evalRepo.listActiveWithEmbeddings(owner);
      expect(active).toHaveLength(1);
      expect(active[0]?.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    });

    it('purges stale candidates only; their results keep the question text', async () => {
      const { evalRepo, owner } = await seeded(1);
      const stale = await evalRepo.createCandidate({
        ownerId: owner,
        question: 'stale',
        embedding: embed('stale'),
        offTopic: false,
        sessionHash: 'a'.repeat(64),
        now: at(1),
      });
      await evalRepo.createCandidate({
        ownerId: owner,
        question: 'fresh',
        embedding: embed('fresh'),
        offTopic: false,
        sessionHash: 'a'.repeat(64),
        now: at(100),
      });
      const run = await evalRepo.createRun(owner, 1, 'manual');
      await evalRepo.finishRun(run.id, {
        status: 'completed',
        error: null,
        results: [
          {
            questionId: stale.id,
            question: 'stale',
            answer: null,
            chunkIds: [],
            topSimilarity: null,
            gap: true,
          },
        ],
      });

      expect(await evalRepo.purgeCandidates(owner, at(50))).toBe(1);
      const texts = (await evalRepo.listQuestions(owner)).map((q) => q.question);
      expect(texts).toContain('fresh');
      expect(texts).not.toContain('stale');
      expect(texts).toContain('canned question number 0');
      const latest = await evalRepo.getLatestRun(owner);
      expect(latest?.results[0]).toMatchObject({ questionId: null, question: 'stale' });
    });

    it('stores runs with their results, in order, and finds the previous version', async () => {
      const { evalRepo, newOwner } = target();
      const owner = newOwner();
      expect(await evalRepo.getLatestRun(owner)).toBeNull();
      expect(await evalRepo.getLatestCompletedRun(owner)).toBeNull();

      const chunkId = randomUUID();
      const v1 = await evalRepo.createRun(owner, 1, 'corpus');
      expect(v1).toMatchObject({ status: 'running', corpusVersion: 1, trigger: 'corpus' });
      await evalRepo.finishRun(v1.id, {
        status: 'completed',
        error: null,
        results: [
          {
            questionId: null,
            question: 'b',
            answer: 'x',
            chunkIds: [chunkId],
            topSimilarity: 0.5,
            gap: false,
          },
          {
            questionId: null,
            question: 'a',
            answer: null,
            chunkIds: [],
            topSimilarity: null,
            gap: true,
          },
        ],
      });
      const failed = await evalRepo.createRun(owner, 2, 'manual');
      await evalRepo.finishRun(failed.id, { status: 'failed', error: 'boom', results: [] });
      const v3 = await evalRepo.createRun(owner, 3, 'corpus');

      const latest = await evalRepo.getLatestRun(owner);
      expect(latest).toMatchObject({ id: v3.id, status: 'running', results: [] });
      expect((await evalRepo.getLatestCompletedRun(owner))?.id).toBe(v1.id);

      const previous = await evalRepo.getPreviousCompletedRun(owner, 3);
      expect(previous?.id).toBe(v1.id);
      expect(previous?.finishedAt).not.toBeNull();
      expect(previous?.results.map((r) => r.question)).toEqual(['b', 'a']);
      expect(previous?.results[0]).toMatchObject({ chunkIds: [chunkId], topSimilarity: 0.5 });
      expect(await evalRepo.getPreviousCompletedRun(owner, 1)).toBeNull();

      expect(await evalRepo.abandonRunning('restarted')).toBeGreaterThanOrEqual(1);
      expect(await evalRepo.getLatestRun(owner)).toMatchObject({
        id: v3.id,
        status: 'failed',
        error: 'restarted',
      });
    });
  });
}

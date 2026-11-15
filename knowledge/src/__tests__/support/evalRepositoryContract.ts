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
        maxCandidates: 500,
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

    it('does not count an ask against a retired question and reports it as not matched', async () => {
      const { evalRepo, owner } = await seeded(1);
      const created = await evalRepo.createCandidate({
        ownerId: owner,
        question: 'Do you know Go?',
        embedding: embed('Do you know Go?'),
        offTopic: false,
        sessionHash: 'a'.repeat(64),
        now: at(10),
        maxCandidates: 500,
      });
      await evalRepo.updateQuestion(owner, created.id, { status: 'retired' }, undefined, at(11));
      expect(await evalRepo.recordAsk(created.id, 'b'.repeat(64), at(12))).toBeNull();
      const after = (await evalRepo.listQuestions(owner)).find((q) => q.id === created.id);
      expect(after).toMatchObject({ status: 'retired', hitCount: 1, distinctSessions: 1 });
      expect(after?.lastAskedAt.getTime()).toBe(at(10).getTime());
    });

    it('promotes, retiring the least recently asked unpinned question when full', async () => {
      const { evalRepo, owner, questions } = await seeded(3);
      const [q0, q1, q2] = questions.sort((a, b) => a.question.localeCompare(b.question));
      if (!q0 || !q1 || !q2) throw new Error('not seeded');
      // q0 asked last, q1 pinned: q2 is the one to go.
      await evalRepo.recordAsk(q0.id, 'c'.repeat(64), at(30));
      await evalRepo.recordAsk(q2.id, 'c'.repeat(64), at(20));
      await evalRepo.recordAsk(q1.id, 'c'.repeat(64), at(1));
      await evalRepo.updateQuestion(owner, q1.id, { pinned: true }, undefined, at(3));

      const candidate = await evalRepo.createCandidate({
        ownerId: owner,
        question: 'new one',
        embedding: embed('new one'),
        offTopic: true,
        sessionHash: 'd'.repeat(64),
        now: at(40),
        maxCandidates: 500,
      });
      const outcome = await evalRepo.promote(owner, candidate.id, 3, at(70));
      expect(outcome.status).toBe('promoted');
      if (outcome.status !== 'promoted') return;
      expect(outcome.question).toMatchObject({ status: 'active', offTopic: false });
      expect(outcome.evicted.map((q) => q.id)).toEqual([q2.id]);
      expect(outcome.evicted[0]?.status).toBe('retired');

      // Promoting an active question changes nothing.
      const again = await evalRepo.promote(owner, candidate.id, 3, at(70));
      expect(again).toMatchObject({ status: 'promoted', evicted: [] });

      // Room left: no eviction.
      const roomy = await evalRepo.promote(owner, q2.id, 4, at(70));
      expect(roomy).toMatchObject({ status: 'promoted', evicted: [] });

      expect(await evalRepo.promote('someone-else', q2.id, 4, at(70))).toEqual({
        status: 'not-found',
      });
    });

    it('evicts as many as needed when the active set is over its size', async () => {
      const { evalRepo, owner, questions } = await seeded(4);
      const candidate = await evalRepo.createCandidate({
        ownerId: owner,
        question: 'over',
        embedding: embed('over'),
        offTopic: false,
        sessionHash: 'a'.repeat(64),
        now: at(60),
        maxCandidates: 500,
      });
      // Four active, room for two: three must go so the new one fits.
      const outcome = await evalRepo.promote(owner, candidate.id, 2, at(70));
      expect(outcome.status).toBe('promoted');
      if (outcome.status !== 'promoted') return;
      expect(outcome.evicted).toHaveLength(3);
      const active = (await evalRepo.listQuestions(owner)).filter((q) => q.status === 'active');
      expect(active.map((q) => q.id).sort()).toEqual(
        [
          candidate.id,
          ...questions.map((q) => q.id).filter((id) => !outcome.evicted.some((e) => e.id === id)),
        ].sort(),
      );
      expect(active).toHaveLength(2);
    });

    it('never matches a retired question as the nearest', async () => {
      const { evalRepo, owner, questions } = await seeded(2);
      const target0 = questions.find((q) => q.question === 'canned question number 0');
      if (!target0) throw new Error('not seeded');
      await evalRepo.updateQuestion(owner, target0.id, { status: 'retired' }, undefined, at(3));
      const nearest = await evalRepo.nearestQuestion(owner, embed('canned question number 0'));
      expect(nearest?.question.id).not.toBe(target0.id);
    });

    it('applies an update only while the status matches', async () => {
      const { evalRepo, owner, questions } = await seeded(1);
      const first = questions[0];
      if (!first) throw new Error('not seeded');
      await evalRepo.updateQuestion(owner, first.id, { status: 'retired' }, undefined, at(3));
      const refused = await evalRepo.updateQuestion(
        owner,
        first.id,
        { pinned: true },
        ['active'],
        at(3),
      );
      expect(refused).toMatchObject({ status: 'conflict', question: { status: 'retired' } });
      expect((await evalRepo.getQuestion(owner, first.id))?.pinned).toBe(false);
      const applied = await evalRepo.updateQuestion(
        owner,
        first.id,
        { offTopic: true },
        ['retired'],
        at(4),
      );
      expect(applied).toMatchObject({ status: 'updated', question: { offTopic: true } });
    });

    it('tracks when a question was retired, and clears it when it comes back', async () => {
      const { evalRepo, owner, questions } = await seeded(2);
      const [q0, q1] = questions;
      if (!q0 || !q1) throw new Error('not seeded');
      expect(q0.retiredAt).toBeNull();

      const retired = await evalRepo.updateQuestion(
        owner,
        q0.id,
        { status: 'retired' },
        undefined,
        at(10),
      );
      expect(retired).toMatchObject({ status: 'updated', question: { retiredAt: at(10) } });
      // Retiring again (or flagging) keeps the original time.
      const again = await evalRepo.updateQuestion(
        owner,
        q0.id,
        { status: 'retired', offTopic: true },
        undefined,
        at(20),
      );
      expect(again).toMatchObject({ question: { retiredAt: at(10) } });

      // Promoted back: cleared. Its eviction victim gets the promotion's time.
      const promoted = await evalRepo.promote(owner, q0.id, 2, at(30));
      expect(promoted).toMatchObject({ status: 'promoted', question: { retiredAt: null } });
      const candidate = await evalRepo.createCandidate({
        ownerId: owner,
        question: 'pushes one out',
        embedding: embed('pushes one out'),
        offTopic: false,
        sessionHash: 'a'.repeat(64),
        now: at(31),
        maxCandidates: 500,
      });
      const evicting = await evalRepo.promote(owner, candidate.id, 2, at(40));
      expect(evicting.status).toBe('promoted');
      if (evicting.status !== 'promoted') return;
      expect(evicting.evicted[0]?.retiredAt).toEqual(at(40));
    });

    it('purges a retired visitor question by its retirement time, not its last ask', async () => {
      const { evalRepo, newOwner } = target();
      const owner = newOwner();
      const old = await evalRepo.createCandidate({
        ownerId: owner,
        question: 'asked long ago',
        embedding: embed('asked long ago'),
        offTopic: false,
        sessionHash: 'a'.repeat(64),
        now: at(1),
        maxCandidates: 500,
      });
      // Retired recently, although last asked long before the cutoff.
      await evalRepo.updateQuestion(owner, old.id, { status: 'retired' }, undefined, at(100));
      expect(await evalRepo.purgeStale(owner, at(50))).toBe(0);
      expect((await evalRepo.getQuestion(owner, old.id))?.status).toBe('retired');
      expect(await evalRepo.purgeStale(owner, at(200))).toBe(1);
    });

    it('caps the candidates per owner, dropping the least recently asked', async () => {
      const { evalRepo, newOwner } = target();
      const owner = newOwner();
      for (const [i, text] of ['one', 'two', 'three'].entries()) {
        await evalRepo.createCandidate({
          ownerId: owner,
          question: text,
          embedding: embed(text),
          offTopic: false,
          sessionHash: 'a'.repeat(64),
          now: at(10 + i),
          maxCandidates: 2,
        });
      }
      const texts = (await evalRepo.listQuestions(owner)).map((q) => q.question);
      expect(texts.sort()).toEqual(['three', 'two']);
    });

    it('refuses to promote when every active question is pinned', async () => {
      const { evalRepo, owner, questions } = await seeded(2);
      for (const q of questions)
        await evalRepo.updateQuestion(owner, q.id, { pinned: true }, undefined, at(3));
      const candidate = await evalRepo.createCandidate({
        ownerId: owner,
        question: 'waiting',
        embedding: embed('waiting'),
        offTopic: false,
        sessionHash: 'e'.repeat(64),
        now: at(5),
        maxCandidates: 500,
      });
      expect(await evalRepo.promote(owner, candidate.id, 2, at(70))).toEqual({ status: 'full' });
      expect((await evalRepo.getQuestion(owner, candidate.id))?.status).toBe('candidate');
    });

    it('scopes updates and reads to the owner, and lists active first', async () => {
      const { evalRepo, owner, questions } = await seeded(2);
      const first = questions[0];
      if (!first) throw new Error('not seeded');
      expect(
        await evalRepo.updateQuestion('someone-else', first.id, { pinned: true }, undefined, at(3)),
      ).toEqual({
        status: 'not-found',
      });
      expect(await evalRepo.getQuestion('someone-else', first.id)).toBeNull();

      await evalRepo.updateQuestion(owner, first.id, { status: 'retired' }, undefined, at(3));
      await evalRepo.createCandidate({
        ownerId: owner,
        question: 'candidate',
        embedding: embed('candidate'),
        offTopic: false,
        sessionHash: 'f'.repeat(64),
        now: at(50),
        maxCandidates: 500,
      });
      const statuses = (await evalRepo.listQuestions(owner)).map((q) => q.status);
      expect(statuses).toEqual(['active', 'candidate', 'retired']);
      const active = await evalRepo.listActiveWithEmbeddings(owner);
      expect(active).toHaveLength(1);
      expect(active[0]?.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    });

    it('purges stale candidates and retired visitor questions; results keep the text', async () => {
      const { evalRepo, owner, questions } = await seeded(1);
      const canned = questions[0];
      if (!canned) throw new Error('not seeded');
      // A retired canned question stays however old; a retired visitor one goes.
      await evalRepo.updateQuestion(owner, canned.id, { status: 'retired' }, undefined, at(3));
      const retiredVisitor = await evalRepo.createCandidate({
        ownerId: owner,
        question: 'retired visitor',
        embedding: embed('retired visitor'),
        offTopic: false,
        sessionHash: 'a'.repeat(64),
        now: at(2),
        maxCandidates: 500,
      });
      await evalRepo.updateQuestion(
        owner,
        retiredVisitor.id,
        { status: 'retired' },
        undefined,
        at(3),
      );
      const stale = await evalRepo.createCandidate({
        ownerId: owner,
        question: 'stale',
        embedding: embed('stale'),
        offTopic: false,
        sessionHash: 'a'.repeat(64),
        now: at(1),
        maxCandidates: 500,
      });
      await evalRepo.createCandidate({
        ownerId: owner,
        question: 'fresh',
        embedding: embed('fresh'),
        offTopic: false,
        sessionHash: 'a'.repeat(64),
        now: at(100),
        maxCandidates: 500,
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

      expect(await evalRepo.purgeStale(owner, at(50))).toBe(2);
      const texts = (await evalRepo.listQuestions(owner)).map((q) => q.question);
      expect(texts).toContain('fresh');
      expect(texts).not.toContain('stale');
      expect(texts).not.toContain('retired visitor');
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
      // The instance that started it can no longer close it as completed.
      expect(
        await evalRepo.finishRun(v3.id, {
          status: 'completed',
          error: null,
          results: [
            {
              questionId: null,
              question: 'late',
              answer: null,
              chunkIds: [],
              topSimilarity: null,
              gap: true,
            },
          ],
        }),
      ).toBe(false);
      expect(await evalRepo.getLatestRun(owner)).toMatchObject({
        id: v3.id,
        status: 'failed',
        results: [],
      });
    });
  });
}

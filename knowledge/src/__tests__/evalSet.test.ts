import { describe, expect, it, vi } from 'vitest';
import { EVAL_ACTIVE_SIZE, EVAL_MAX_QUESTION_CHARS } from '../contract.js';
import type { EvalQuestionRecord } from '../db/api/evalRepository.js';
import { CANNED_EVAL_QUESTIONS } from '../services/evalSet/canned.js';
import {
  createEvalSet,
  EvalQuestionNotFoundError,
  hashSessionId,
  type RecordInput,
} from '../services/evalSet/evalSet.js';
import {
  EMAIL_MASK,
  HANDLE_MASK,
  LINK_MASK,
  PHONE_MASK,
  redactQuestion,
} from '../services/evalSet/redact.js';
import { silentLogger } from './support/fixtures.js';
import { createMemoryEvalRepository } from './support/memoryEvalRepository.js';
import { axis, createStubEmbedder, near } from './support/stubEmbedder.js';

const DIMS = 32;
const OWNER = 'owner';

// Each canned question sits on its own axis, so none is near another.
const CANNED_VECTORS = Object.fromEntries(CANNED_EVAL_QUESTIONS.map((q, i) => [q, axis(i, DIMS)]));

const NOVEL = 'Do you have experience with Rust?';
const NEAR_NOVEL = 'Have you ever written Rust?';
const OTHER_NOVEL = 'Have you worked with GraphQL?';
const OFF_TOPIC = 'What is the weather like today?';

const VECTORS: Record<string, number[]> = {
  ...CANNED_VECTORS,
  [NOVEL]: axis(12, DIMS),
  // 0.9 to NOVEL: above the 0.85 clustering threshold.
  [NEAR_NOVEL]: near(12, 13, 0.9, DIMS),
  // 0.6 to NOVEL: a different question.
  [OTHER_NOVEL]: near(12, 14, 0.6, DIMS),
  [OFF_TOPIC]: axis(20, DIMS),
};

function setup() {
  const repo = createMemoryEvalRepository();
  const embedder = createStubEmbedder(VECTORS, DIMS);
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const now = () => new Date((clock += 60_000));
  const evalSet = createEvalSet({ repo, embedder, log: silentLogger, now });

  /** Records `question` as a visitor would ask it, reusing the stub's embedding. */
  async function ask(question: string, sessionId: string, topSimilarity: number | null = 0.5) {
    const [embedding] = await embedder.embed([question]);
    if (!embedding) throw new Error('no embedding');
    const input: RecordInput = { ownerId: OWNER, question, sessionId, embedding, topSimilarity };
    return evalSet.record(input);
  }

  const byText = async (text: string): Promise<EvalQuestionRecord | undefined> =>
    (await repo.listQuestions(OWNER)).find((q) => q.question === text);
  const active = async () =>
    (await repo.listQuestions(OWNER)).filter((q) => q.status === 'active').map((q) => q.question);

  /** Asks every canned question but the first, so the first is the least recently asked. */
  async function touchAllCannedButFirst() {
    for (const q of CANNED_EVAL_QUESTIONS.slice(1)) await ask(q, 'warm-up-session');
  }

  return { repo, embedder, evalSet, ask, byText, active, touchAllCannedButFirst };
}

describe('eval set: seeding', () => {
  it('starts from the canned questions, all active, once', async () => {
    const { evalSet, active, repo } = setup();
    await evalSet.ensureSeeded(OWNER);
    await evalSet.ensureSeeded(OWNER);
    expect(await active()).toHaveLength(CANNED_EVAL_QUESTIONS.length);
    expect(CANNED_EVAL_QUESTIONS.length).toBe(EVAL_ACTIVE_SIZE);
    expect(repo.questions.size).toBe(CANNED_EVAL_QUESTIONS.length);
    const [first] = await repo.listQuestions(OWNER);
    expect(first).toMatchObject({ origin: 'canned', hitCount: 0, distinctSessions: 0 });
  });
});

describe('eval set: clustering', () => {
  it('bumps the existing cluster for a near-duplicate question', async () => {
    const { ask, repo, byText } = setup();
    const first = await ask(NOVEL, 'session-aaaa');
    expect(first).toMatchObject({ kind: 'created' });

    const again = await ask(NEAR_NOVEL, 'session-aaaa');
    expect(again.kind).toBe('joined');
    expect(again.question.id).toBe(first.question.id);
    expect(again.question).toMatchObject({ hitCount: 2, distinctSessions: 1 });
    expect(again.question.lastAskedAt.getTime()).toBeGreaterThan(
      first.question.lastAskedAt.getTime(),
    );
    // Stored under its first wording; the near-duplicate starts nothing.
    expect(await byText(NEAR_NOVEL)).toBeUndefined();
    expect([...repo.questions.values()].filter((q) => q.origin === 'visitor')).toHaveLength(1);
  });

  it('starts a new candidate for a question below the clustering threshold', async () => {
    const { ask, byText } = setup();
    await ask(NOVEL, 'session-aaaa');
    const other = await ask(OTHER_NOVEL, 'session-aaaa');
    expect(other.kind).toBe('created');
    expect(await byText(OTHER_NOVEL)).toMatchObject({ status: 'candidate', hitCount: 1 });
  });

  it('a near-duplicate of a canned question bumps the canned question', async () => {
    const { ask, repo } = setup();
    const canned = CANNED_EVAL_QUESTIONS[3] ?? '';
    const outcome = await ask(canned, 'session-aaaa');
    expect(outcome).toMatchObject({ kind: 'joined' });
    expect(outcome.question).toMatchObject({ origin: 'canned', status: 'active', hitCount: 1 });
    expect([...repo.questions.values()].filter((q) => q.origin === 'visitor')).toHaveLength(0);
  });

  it('stores only a hash of the session id', async () => {
    const { ask, repo } = setup();
    const { question } = await ask(NOVEL, 'session-secret-1');
    const sessions = [...(repo.sessions.get(question.id) ?? [])];
    expect(sessions).toEqual([hashSessionId('session-secret-1')]);
    expect(sessions[0]).not.toContain('session-secret-1');
  });
});

describe('eval set: candidates and owner promotion', () => {
  it('keeps a novel question asked from one session a candidate', async () => {
    const { ask, byText } = setup();
    await ask(NOVEL, 'session-aaaa');
    await ask(NOVEL, 'session-aaaa');
    await ask(NEAR_NOVEL, 'session-aaaa');
    expect(await byText(NOVEL)).toMatchObject({
      status: 'candidate',
      hitCount: 3,
      distinctSessions: 1,
    });
  });

  it('never promotes on its own: a question from two sessions stays a candidate', async () => {
    const { ask, byText, active } = setup();
    await ask(NOVEL, 'session-aaaa');
    const second = await ask(NEAR_NOVEL, 'session-bbbb');
    // Even many sessions (client-chosen ids) cannot push a question in.
    for (const s of ['session-cccc', 'session-dddd', 'session-eeee']) await ask(NOVEL, s);

    expect(second.question).toMatchObject({ question: NOVEL, status: 'candidate' });
    expect(await byText(NOVEL)).toMatchObject({ status: 'candidate', distinctSessions: 5 });
    expect(await active()).toEqual(expect.not.arrayContaining([NOVEL]));
    expect(await active()).toHaveLength(EVAL_ACTIVE_SIZE);
  });

  it('an owner promote evicts the least recently asked unpinned question', async () => {
    const { ask, evalSet, byText, active, touchAllCannedButFirst } = setup();
    await touchAllCannedButFirst();
    const lru = CANNED_EVAL_QUESTIONS[0] ?? '';
    await ask(NOVEL, 'session-aaaa');
    const { question } = await ask(NOVEL, 'session-bbbb');
    expect(question).toMatchObject({ status: 'candidate', distinctSessions: 2 });

    const promoted = await evalSet.act(OWNER, question.id, 'promote');
    expect(promoted.question).toMatchObject({ question: NOVEL, status: 'active' });
    expect(promoted.evicted.map((q) => q.question)).toEqual([lru]);
    expect(await byText(lru)).toMatchObject({ status: 'retired' });
    const now = await active();
    expect(now).toHaveLength(EVAL_ACTIVE_SIZE);
    expect(now).toContain(NOVEL);
    expect(now).not.toContain(lru);
  });

  it('promotes without evicting while the active set has room', async () => {
    const { ask, evalSet, repo } = setup();
    await evalSet.ensureSeeded(OWNER);
    const first = (await repo.listQuestions(OWNER))[0];
    if (!first) throw new Error('not seeded');
    await evalSet.act(OWNER, first.id, 'retire');

    const { question } = await ask(NOVEL, 'session-aaaa');
    const promoted = await evalSet.act(OWNER, question.id, 'promote');
    expect(promoted).toMatchObject({ evicted: [] });
    expect(promoted.question.status).toBe('active');
  });

  it('never evicts a pinned question', async () => {
    const { ask, evalSet, byText, touchAllCannedButFirst } = setup();
    await touchAllCannedButFirst();
    const lru = await byText(CANNED_EVAL_QUESTIONS[0] ?? '');
    if (!lru) throw new Error('not seeded');
    await evalSet.act(OWNER, lru.id, 'pin');

    const { question } = await ask(NOVEL, 'session-aaaa');
    const promoted = await evalSet.act(OWNER, question.id, 'promote');
    // The next least recently asked unpinned question goes instead.
    expect(promoted.evicted.map((q) => q.question)).toEqual([CANNED_EVAL_QUESTIONS[1]]);
    expect(await byText(CANNED_EVAL_QUESTIONS[0] ?? '')).toMatchObject({
      status: 'active',
      pinned: true,
    });
  });

  it('refuses to promote when every active question is pinned', async () => {
    const { ask, evalSet, repo, byText } = setup();
    await evalSet.ensureSeeded(OWNER);
    for (const q of await repo.listQuestions(OWNER)) await evalSet.act(OWNER, q.id, 'pin');
    const { question } = await ask(NOVEL, 'session-aaaa');
    await expect(evalSet.act(OWNER, question.id, 'promote')).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await byText(NOVEL)).toMatchObject({ status: 'candidate' });
    const all = await repo.listQuestions(OWNER);
    expect(all.filter((q) => q.status === 'active' && q.pinned)).toHaveLength(EVAL_ACTIVE_SIZE);
  });

  it('evicts enough to get back under the size when the set is over it', async () => {
    const { ask, evalSet, repo } = setup();
    await evalSet.ensureSeeded(OWNER);
    // Two questions too many active (e.g. a smaller size configured later).
    for (const text of [NOVEL, OTHER_NOVEL]) {
      const { question } = await ask(text, 'session-aaaa');
      await repo.updateQuestion(OWNER, question.id, { status: 'active' }, undefined, new Date());
    }
    const { question } = await ask(OFF_TOPIC, 'session-aaaa', 0.5);
    const promoted = await evalSet.act(OWNER, question.id, 'promote');
    expect(promoted.evicted).toHaveLength(3);
    const active = (await repo.listQuestions(OWNER)).filter((q) => q.status === 'active');
    expect(active).toHaveLength(EVAL_ACTIVE_SIZE);
  });

  it('flags a question off-topic when the corpus answered poorly; it is never suggested', async () => {
    const { ask, byText } = setup();
    // The corpus answered, but its best chunk is far below the off-topic threshold.
    const first = await ask(OFF_TOPIC, 'session-aaaa', 0.02);
    expect(first.question.offTopic).toBe(true);
    await ask(OFF_TOPIC, 'session-bbbb', 0.02);
    await ask(OFF_TOPIC, 'session-cccc', 0.02);
    expect(await byText(OFF_TOPIC)).toMatchObject({
      status: 'candidate',
      offTopic: true,
      distinctSessions: 3,
    });
  });

  it('does not flag a question off-topic when the corpus returned nothing', async () => {
    const { ask } = setup();
    const outcome = await ask(NOVEL, 'session-aaaa', null);
    expect(outcome.question.offTopic).toBe(false);
  });

  it('never absorbs new asks into a retired question; they start a fresh candidate', async () => {
    const { ask, evalSet, repo } = setup();
    const { question } = await ask(NOVEL, 'session-aaaa');
    await evalSet.act(OWNER, question.id, 'retire');
    const again = await ask(NEAR_NOVEL, 'session-bbbb');
    expect(again.kind).toBe('created');
    expect(again.question).toMatchObject({ status: 'candidate', question: NEAR_NOVEL });
    expect((await repo.getQuestion(OWNER, question.id))?.hitCount).toBe(1);
  });

  it('keeps at most the configured number of candidates, dropping the least recently asked', async () => {
    const repo = createMemoryEvalRepository();
    const embedder = createStubEmbedder(VECTORS, DIMS);
    let clock = Date.parse('2026-11-01T00:00:00Z');
    const evalSet = createEvalSet({
      repo,
      embedder,
      log: silentLogger,
      now: () => new Date((clock += 60_000)),
      settings: { maxCandidates: 2 },
    });
    for (const text of [NOVEL, OTHER_NOVEL, OFF_TOPIC]) {
      const [embedding] = await embedder.embed([text]);
      if (!embedding) throw new Error('no embedding');
      await evalSet.record({
        ownerId: OWNER,
        question: text,
        sessionId: 'session-aaaa',
        embedding,
        topSimilarity: 0.5,
      });
    }
    const candidates = (await repo.listQuestions(OWNER))
      .filter((q) => q.status === 'candidate')
      .map((q) => q.question);
    expect(candidates.sort()).toEqual([OFF_TOPIC, OTHER_NOVEL].sort());
  });
});

describe('eval set: owner controls', () => {
  it('pins only active questions, and promote overrides the off-topic flag', async () => {
    const { ask, evalSet } = setup();
    const { question } = await ask(OFF_TOPIC, 'session-aaaa', 0.01);
    await expect(evalSet.act(OWNER, question.id, 'pin')).rejects.toMatchObject({
      statusCode: 409,
    });
    const promoted = await evalSet.act(OWNER, question.id, 'promote');
    expect(promoted.question).toMatchObject({ status: 'active', offTopic: false });
    expect(promoted.evicted).toHaveLength(1);
    const pinned = await evalSet.act(OWNER, question.id, 'pin');
    expect(pinned.question.pinned).toBe(true);
  });

  it('flagging an active question off-topic retires and unpins it', async () => {
    const { evalSet, repo } = setup();
    await evalSet.ensureSeeded(OWNER);
    const first = (await repo.listQuestions(OWNER))[0];
    if (!first) throw new Error('not seeded');
    await evalSet.act(OWNER, first.id, 'pin');
    const flagged = await evalSet.act(OWNER, first.id, 'off-topic');
    expect(flagged.question).toMatchObject({ status: 'retired', pinned: false, offTopic: true });
    const cleared = await evalSet.act(OWNER, first.id, 'on-topic');
    expect(cleared.question.offTopic).toBe(false);
  });

  it('flags a candidate off-topic without changing its status', async () => {
    const { ask, evalSet } = setup();
    const { question } = await ask(NOVEL, 'session-aaaa');
    const flagged = await evalSet.act(OWNER, question.id, 'off-topic');
    expect(flagged.question).toMatchObject({ status: 'candidate', offTopic: true });
  });

  it('refuses a pin when the question was retired meanwhile (status-guarded)', async () => {
    const { evalSet, repo } = setup();
    await evalSet.ensureSeeded(OWNER);
    const first = (await repo.listQuestions(OWNER))[0];
    if (!first) throw new Error('not seeded');
    // As if a concurrent promotion had just evicted it.
    await repo.updateQuestion(OWNER, first.id, { status: 'retired' }, undefined, new Date());
    await expect(evalSet.act(OWNER, first.id, 'pin')).rejects.toMatchObject({ statusCode: 409 });
    expect((await repo.getQuestion(OWNER, first.id))?.pinned).toBe(false);
  });

  it('answers 404 for a question of another owner', async () => {
    const { ask, evalSet } = setup();
    const { question } = await ask(NOVEL, 'session-aaaa');
    await expect(evalSet.act('someone-else', question.id, 'retire')).rejects.toBeInstanceOf(
      EvalQuestionNotFoundError,
    );
    await expect(evalSet.act('someone-else', question.id, 'promote')).rejects.toBeInstanceOf(
      EvalQuestionNotFoundError,
    );
  });
});

describe('eval set: purge', () => {
  it('deletes stale retired visitor questions too, never canned or active ones', async () => {
    const repo = createMemoryEvalRepository();
    const embedder = createStubEmbedder(VECTORS, DIMS);
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const evalSet = createEvalSet({
      repo,
      embedder,
      log: silentLogger,
      now: () => new Date(clock),
    });
    const [embedding] = await embedder.embed([NOVEL]);
    if (!embedding) throw new Error('no embedding');
    const { question } = await evalSet.record({
      ownerId: OWNER,
      question: NOVEL,
      sessionId: 'session-aaaa',
      embedding,
      topSimilarity: 0.5,
    });
    await evalSet.act(OWNER, question.id, 'retire');
    const canned = (await repo.listQuestions(OWNER))[0];
    if (!canned) throw new Error('not seeded');
    await evalSet.act(OWNER, canned.id, 'retire');
    clock += 91 * 24 * 60 * 60 * 1000;

    expect(await evalSet.purge(OWNER)).toBe(1);
    expect(await repo.getQuestion(OWNER, question.id)).toBeNull();
    expect(await repo.getQuestion(OWNER, canned.id)).not.toBeNull();
  });

  it('never fails the owner view when purging fails, and retries next time', async () => {
    const repo = createMemoryEvalRepository();
    const evalSet = createEvalSet({
      repo,
      embedder: createStubEmbedder(VECTORS, DIMS),
      log: silentLogger,
    });
    await evalSet.ensureSeeded(OWNER);
    const purgeStale = vi
      .spyOn(repo, 'purgeStale')
      .mockRejectedValueOnce(new Error('database hiccup'));
    expect(await evalSet.list(OWNER)).toHaveLength(CANNED_EVAL_QUESTIONS.length);
    await evalSet.list(OWNER);
    expect(purgeStale).toHaveBeenCalledTimes(2);
    // Succeeded the second time: throttled from now on.
    await evalSet.list(OWNER);
    expect(purgeStale).toHaveBeenCalledTimes(2);
  });

  it('deletes candidates not asked within 90 days, and nothing else', async () => {
    const repo = createMemoryEvalRepository();
    const embedder = createStubEmbedder(VECTORS, DIMS);
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const evalSet = createEvalSet({
      repo,
      embedder,
      log: silentLogger,
      now: () => new Date(clock),
    });
    const ask = async (question: string, sessionId: string) => {
      const [embedding] = await embedder.embed([question]);
      if (!embedding) throw new Error('no embedding');
      return evalSet.record({ ownerId: OWNER, question, sessionId, embedding, topSimilarity: 0.5 });
    };

    await ask(NOVEL, 'session-aaaa');
    clock += 30 * 24 * 60 * 60 * 1000;
    await ask(OTHER_NOVEL, 'session-aaaa');
    clock += 61 * 24 * 60 * 60 * 1000;

    expect(await evalSet.purge(OWNER)).toBe(1);
    const texts = (await repo.listQuestions(OWNER)).map((q) => q.question);
    expect(texts).not.toContain(NOVEL);
    expect(texts).toContain(OTHER_NOVEL);
    // Canned questions are active, not candidates, so they stay however old.
    expect(texts).toHaveLength(CANNED_EVAL_QUESTIONS.length + 1);
  });
});

describe('eval set: redaction', () => {
  it('masks emails and phone numbers, and truncates', () => {
    expect(redactQuestion('Can I email you at jane.doe+jobs@example.co.uk?')).toBe(
      `Can I email you at ${EMAIL_MASK}?`,
    );
    expect(redactQuestion('Call me on +1 (555) 123-4567 tomorrow')).toBe(
      `Call me on ${PHONE_MASK} tomorrow`,
    );
    expect(redactQuestion('or 555.123.4567')).toBe(`or ${PHONE_MASK}`);
    // Not phone numbers.
    expect(redactQuestion('What did you do from 2019 - 2024?')).toBe(
      'What did you do from 2019 - 2024?',
    );
    expect(redactQuestion('Did you serve 2,000,000 requests?')).toBe(
      'Did you serve 2,000,000 requests?',
    );
    // Links and handles (defense in depth).
    expect(redactQuestion('See https://example.com/u/jane?id=42 first')).toBe(
      `See ${LINK_MASK} first`,
    );
    expect(redactQuestion('my profile: linkedin.com/in/jane-doe')).toBe(`my profile: ${LINK_MASK}`);
    expect(redactQuestion('DM @jane_doe or (@jd) on X')).toBe(
      `DM ${HANDLE_MASK} or (${HANDLE_MASK}) on X`,
    );
    // Not links or handles.
    expect(redactQuestion('Do you use Node.js/Express or C#?')).toBe(
      'Do you use Node.js/Express or C#?',
    );
    const long = redactQuestion(`${'a'.repeat(EVAL_MAX_QUESTION_CHARS)} jane@example.com`);
    expect(Array.from(long)).toHaveLength(EVAL_MAX_QUESTION_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  it('masks before cutting, so a contact detail at the limit cannot leak in part', () => {
    const question = `${'x '.repeat((EVAL_MAX_QUESTION_CHARS - 10) / 2)}reach me at someone@example.com`;
    expect(redactQuestion(question)).not.toContain('someone');
  });

  it('applies redaction before storage, and embeds the redacted text', async () => {
    const { ask, repo, embedder } = setup();
    const raw = 'Ping me at jane@example.com or 555-123-4567 about the Rust role';
    const { question } = await ask(raw, 'session-aaaa');

    const expected = `Ping me at ${EMAIL_MASK} or ${PHONE_MASK} about the Rust role`;
    expect(question.question).toBe(expected);
    const stored = repo.questions.get(question.id);
    expect(JSON.stringify(stored)).not.toContain('jane@example.com');
    expect(JSON.stringify(stored)).not.toContain('123-4567');
    // The stored embedding is the redacted text's, not the raw query's.
    expect(embedder.calls.at(-1)).toEqual([expected]);
  });
});

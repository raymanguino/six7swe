import { describe, expect, it } from 'vitest';
import { EVAL_ACTIVE_SIZE, EVAL_MAX_QUESTION_CHARS } from '../contract.js';
import type { EvalQuestionRecord } from '../db/api/evalRepository.js';
import { CANNED_EVAL_QUESTIONS } from '../services/evalSet/canned.js';
import {
  createEvalSet,
  EvalQuestionNotFoundError,
  hashSessionId,
  type RecordInput,
} from '../services/evalSet/evalSet.js';
import { EMAIL_MASK, PHONE_MASK, redactQuestion } from '../services/evalSet/redact.js';
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
    expect(first).toMatchObject({ kind: 'created', promoted: false });

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
    expect(outcome).toMatchObject({ kind: 'joined', promoted: false });
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

describe('eval set: promotion and eviction', () => {
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

  it('promotes a novel question asked from two sessions, evicting the least recently asked', async () => {
    const { ask, byText, active, touchAllCannedButFirst } = setup();
    await touchAllCannedButFirst();
    const lru = CANNED_EVAL_QUESTIONS[0] ?? '';

    await ask(NOVEL, 'session-aaaa');
    const second = await ask(NEAR_NOVEL, 'session-bbbb');

    expect(second.promoted).toBe(true);
    expect(second.question).toMatchObject({ question: NOVEL, status: 'active' });
    expect(second.evicted?.question).toBe(lru);
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

    await ask(NOVEL, 'session-aaaa');
    const second = await ask(NOVEL, 'session-bbbb');
    expect(second).toMatchObject({ promoted: true, evicted: null });
  });

  it('never evicts a pinned question', async () => {
    const { ask, evalSet, byText, touchAllCannedButFirst } = setup();
    await touchAllCannedButFirst();
    const lru = await byText(CANNED_EVAL_QUESTIONS[0] ?? '');
    if (!lru) throw new Error('not seeded');
    await evalSet.act(OWNER, lru.id, 'pin');

    await ask(NOVEL, 'session-aaaa');
    const promoted = await ask(NOVEL, 'session-bbbb');
    expect(promoted.promoted).toBe(true);
    // The next least recently asked unpinned question goes instead.
    expect(promoted.evicted?.question).toBe(CANNED_EVAL_QUESTIONS[1]);
    expect(await byText(CANNED_EVAL_QUESTIONS[0] ?? '')).toMatchObject({
      status: 'active',
      pinned: true,
    });
  });

  it('leaves the candidate waiting when every active question is pinned', async () => {
    const { ask, evalSet, repo, byText } = setup();
    await evalSet.ensureSeeded(OWNER);
    for (const q of await repo.listQuestions(OWNER)) await evalSet.act(OWNER, q.id, 'pin');

    await ask(NOVEL, 'session-aaaa');
    const outcome = await ask(NOVEL, 'session-bbbb');
    expect(outcome).toMatchObject({ promoted: false, evicted: null });
    expect(await byText(NOVEL)).toMatchObject({ status: 'candidate', distinctSessions: 2 });
    const all = await repo.listQuestions(OWNER);
    expect(all.filter((q) => q.status === 'active' && q.pinned)).toHaveLength(EVAL_ACTIVE_SIZE);
  });

  it('never promotes an off-topic question', async () => {
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

  it('does not promote a retired question again on its own', async () => {
    const { ask, evalSet, byText } = setup();
    await ask(NOVEL, 'session-aaaa');
    await ask(NOVEL, 'session-bbbb');
    const promoted = await byText(NOVEL);
    if (!promoted) throw new Error('missing');
    await evalSet.act(OWNER, promoted.id, 'retire');
    await ask(NOVEL, 'session-cccc');
    expect(await byText(NOVEL)).toMatchObject({ status: 'retired', distinctSessions: 3 });
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
    expect(promoted.evicted).not.toBeNull();
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

  it('refuses to promote when every active question is pinned', async () => {
    const { ask, evalSet, repo } = setup();
    await evalSet.ensureSeeded(OWNER);
    for (const q of await repo.listQuestions(OWNER)) await evalSet.act(OWNER, q.id, 'pin');
    const { question } = await ask(NOVEL, 'session-aaaa');
    await expect(evalSet.act(OWNER, question.id, 'promote')).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('answers 404 for a question of another owner', async () => {
    const { ask, evalSet } = setup();
    const { question } = await ask(NOVEL, 'session-aaaa');
    await expect(evalSet.act('someone-else', question.id, 'retire')).rejects.toBeInstanceOf(
      EvalQuestionNotFoundError,
    );
  });
});

describe('eval set: purge', () => {
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

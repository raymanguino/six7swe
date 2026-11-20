import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import {
  CHAT_EXAMPLE_QUESTIONS,
  CHAT_EXAMPLES_SHOWN,
  EVAL_ACTIVE_SIZE,
  EVAL_MAX_QUESTION_CHARS,
  EvalStateResponseSchema,
  ExampleClickResponseSchema,
  MAX_CHAT_EXAMPLES,
  isChatExampleQuestion,
  pickChatExamples,
} from '../contract.js';
import { CANNED_EVAL_QUESTIONS } from '../services/evalSet/canned.js';
import { createEvalSet, DEFAULT_EVAL_SETTINGS } from '../services/evalSet/evalSet.js';
import { redactQuestion } from '../services/evalSet/redact.js';
import { createHashingEmbedder } from '../services/embedding/hashing.js';
import { createMemoryFileStore, silentLogger } from './support/fixtures.js';
import { createMemoryEvalRepository } from './support/memoryEvalRepository.js';
import { createMemoryRepository } from './support/memoryRepository.js';
import { createStubEmbedder } from './support/stubEmbedder.js';

const OWNER = 'owner';
const DIMS = 32;

describe('chat example pool', () => {
  it('stays well under the active size, since every example is pinned', () => {
    // Promotion only evicts unpinned questions, so at least four active slots stay free.
    expect(CHAT_EXAMPLE_QUESTIONS.length).toBeLessThanOrEqual(EVAL_ACTIVE_SIZE - 4);
    expect(CHAT_EXAMPLE_QUESTIONS.length).toBeLessThanOrEqual(MAX_CHAT_EXAMPLES);
    expect(DEFAULT_EVAL_SETTINGS.activeSize - CHAT_EXAMPLE_QUESTIONS.length).toBeGreaterThanOrEqual(
      4,
    );
    expect(CHAT_EXAMPLE_QUESTIONS.length).toBeGreaterThanOrEqual(CHAT_EXAMPLES_SHOWN.max);
  });

  it('holds distinct texts that are stored as they are', () => {
    expect(new Set(CHAT_EXAMPLE_QUESTIONS).size).toBe(CHAT_EXAMPLE_QUESTIONS.length);
    for (const text of CHAT_EXAMPLE_QUESTIONS) {
      // A click is matched by exact text, so redaction and trimming must leave it alone.
      expect(redactQuestion(text)).toBe(text);
      expect(text.trim()).toBe(text);
      expect(text.length).toBeLessThanOrEqual(EVAL_MAX_QUESTION_CHARS);
      expect(CANNED_EVAL_QUESTIONS).not.toContain(text);
    }
  });

  it('matches exact texts only', () => {
    const [first] = CHAT_EXAMPLE_QUESTIONS;
    expect(isChatExampleQuestion(first)).toBe(true);
    expect(isChatExampleQuestion(` ${first}`)).toBe(false);
    expect(isChatExampleQuestion(first.toLowerCase())).toBe(false);
  });

  it('picks a random 3 or 4 distinct examples', () => {
    const counts = new Set<number>();
    let seed = 1;
    // A small deterministic generator, so the test covers both sizes every time.
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (let i = 0; i < 200; i++) {
      const picked = pickChatExamples(random);
      counts.add(picked.length);
      expect(new Set(picked).size).toBe(picked.length);
      expect(picked.every((q) => isChatExampleQuestion(q))).toBe(true);
    }
    expect([...counts].sort()).toEqual([3, 4]);
    expect(pickChatExamples(() => 0)).toHaveLength(3);
    expect(pickChatExamples(() => 0.999)).toHaveLength(4);
  });
});

function setup() {
  const repo = createMemoryEvalRepository();
  const embedder = createStubEmbedder({}, DIMS);
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const now = () => new Date((clock += 60_000));
  const evalSet = createEvalSet({ repo, embedder, log: silentLogger, now });
  const active = async () => (await repo.listQuestions(OWNER)).filter((q) => q.status === 'active');
  return { repo, embedder, evalSet, active };
}

describe('eval set: example questions', () => {
  it('seeds every example in the pool as a pinned active question', async () => {
    const { evalSet, active, repo } = setup();
    await evalSet.ensureSeeded(OWNER);
    await evalSet.ensureSeeded(OWNER);

    const list = await active();
    expect(list).toHaveLength(EVAL_ACTIVE_SIZE);
    for (const text of CHAT_EXAMPLE_QUESTIONS) {
      const found = list.filter((q) => q.question === text);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ origin: 'example', pinned: true, exampleClicks: 0 });
    }
    // The canned questions fill the rest; none had to be retired on a fresh owner.
    expect(list.filter((q) => q.origin === 'canned')).toHaveLength(
      EVAL_ACTIVE_SIZE - CHAT_EXAMPLE_QUESTIONS.length,
    );
    expect(repo.questions.size).toBe(EVAL_ACTIVE_SIZE);
  });

  it('adds the examples to an existing set, retiring unpinned questions to make room', async () => {
    const { repo, embedder, active } = setup();
    // An owner seeded before the examples existed: ten canned questions.
    const before = createEvalSet({ repo, embedder, log: silentLogger, examples: [] });
    await before.ensureSeeded(OWNER);
    expect(await active()).toHaveLength(EVAL_ACTIVE_SIZE);

    const after = createEvalSet({ repo, embedder, log: silentLogger });
    await after.ensureSeeded(OWNER);
    const list = await active();
    expect(list).toHaveLength(EVAL_ACTIVE_SIZE);
    expect(list.filter((q) => q.origin === 'example' && q.pinned)).toHaveLength(
      CHAT_EXAMPLE_QUESTIONS.length,
    );
    const retired = (await repo.listQuestions(OWNER)).filter((q) => q.status === 'retired');
    expect(retired).toHaveLength(CHAT_EXAMPLE_QUESTIONS.length);
    expect(retired.every((q) => q.origin === 'canned')).toBe(true);
  });

  it('counts a click on its example only: no embedding, no candidate, no typed counts', async () => {
    const { evalSet, repo, embedder } = setup();
    await evalSet.ensureSeeded(OWNER);
    const [text] = CHAT_EXAMPLE_QUESTIONS;
    const before = await repo.listQuestions(OWNER);
    const embedCalls = embedder.calls.length;

    expect(await evalSet.recordExampleClick(OWNER, text)).toBe(true);
    expect(await evalSet.recordExampleClick(OWNER, text)).toBe(true);
    await evalSet.idle();

    expect(embedder.calls).toHaveLength(embedCalls);
    const after = await repo.listQuestions(OWNER);
    expect(after).toHaveLength(before.length);
    expect(after.some((q) => q.status === 'candidate')).toBe(false);
    for (const q of after) {
      const old = before.find((b) => b.id === q.id);
      expect(q.exampleClicks).toBe(q.question === text ? 2 : 0);
      expect(q).toMatchObject({
        hitCount: old?.hitCount,
        distinctSessions: old?.distinctSessions,
        lastAskedAt: old?.lastAskedAt,
        status: old?.status,
      });
    }
    // Not an example: nothing to count.
    expect(await evalSet.recordExampleClick(OWNER, 'What is your favorite color?')).toBe(false);
  });
});

describe('POST /eval/example-clicks', () => {
  const KEY = 'k'.repeat(40);
  const OWNER_KEY = 'o'.repeat(40);

  async function app() {
    const evalRepo = createMemoryEvalRepository();
    const built = await buildApp({
      deps: {
        repo: createMemoryRepository(),
        files: createMemoryFileStore(),
        embedder: createHashingEmbedder(256),
      },
      evaluation: { repo: evalRepo, answerer: null },
      serviceKey: KEY,
      ownerKey: OWNER_KEY,
      ownerId: OWNER,
      maxUploadBytes: 2048,
      logger: false,
    });
    return { app: built, evalRepo };
  }

  it('counts an exact example with the service key, and refuses anything else', async () => {
    const { app: server, evalRepo } = await app();
    try {
      const [text] = CHAT_EXAMPLE_QUESTIONS;
      const click = (question: string, key = KEY) =>
        server.inject({
          method: 'POST',
          url: '/eval/example-clicks',
          headers: { 'x-knowledge-key': key },
          payload: { question },
        });

      const ok = await click(text);
      expect(ok.statusCode).toBe(200);
      expect(ExampleClickResponseSchema.parse(ok.json())).toEqual({ counted: true });
      const stored = (await evalRepo.listQuestions(OWNER)).find((q) => q.question === text);
      expect(stored).toMatchObject({ origin: 'example', exampleClicks: 1, hitCount: 0 });

      expect((await click(`${text} `)).statusCode).toBe(400);
      expect((await click('Something typed')).statusCode).toBe(400);
      expect((await click(text, OWNER_KEY)).statusCode).toBe(401);

      // The owner's view carries the count.
      const state = await server.inject({
        method: 'GET',
        url: '/eval',
        headers: { 'x-knowledge-key': OWNER_KEY },
      });
      const { questions } = EvalStateResponseSchema.parse(state.json());
      expect(questions.find((q) => q.question === text)?.exampleClicks).toBe(1);
    } finally {
      await server.evalSet.idle();
      await server.close();
    }
  });
});

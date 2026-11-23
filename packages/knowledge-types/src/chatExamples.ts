/**
 * The chat widget's example questions (#205): the one list both the frontend
 * (which shows a random few) and the knowledge service (which seeds each one
 * as a pinned active eval question, origin `example`) read.
 *
 * This module imports nothing, not even zod: the frontend compiles it from
 * source (a Vite alias and a tsconfig path), so it needs neither this
 * package's build step nor its dependencies.
 *
 * Every example is pinned in the eval set, and a promotion only evicts
 * unpinned questions, so the pool must stay well under the active size
 * (`EVAL_ACTIVE_SIZE`, 10): at most `MAX_CHAT_EXAMPLES`, which leaves at
 * least four active slots for typed and MCP questions. The knowledge
 * service's tests enforce it. The texts are matched exactly (a click bumps
 * the example's `example_clicks` by its text), so an edit here seeds a new
 * eval question and leaves the old one for the owner to retire.
 */
export const CHAT_EXAMPLE_QUESTIONS = [
  'What technologies do you work with daily?',
  'Can you describe a challenging project you worked on?',
  'How do you ensure code quality and security?',
  "What's your experience with team collaboration?",
  'What have you built with AI and LLM tooling?',
  'What kind of products and teams have you worked on?',
] as const;

export type ChatExampleQuestion = (typeof CHAT_EXAMPLE_QUESTIONS)[number];

/** The largest the pool may be: the eval set's active size (10) minus 4. */
export const MAX_CHAT_EXAMPLES = 6;

/** The widget shows this many examples at once, chosen at random: 3 or 4. */
export const CHAT_EXAMPLES_SHOWN = { min: 3, max: 4 } as const;

/** Whether `text` is exactly one of the examples (no trimming, no case folding). */
export function isChatExampleQuestion(text: string): text is ChatExampleQuestion {
  return (CHAT_EXAMPLE_QUESTIONS as readonly string[]).includes(text);
}

/**
 * A random 3 or 4 of the examples, in random order. `random` returns a number
 * in [0, 1), like `Math.random`; tests pass their own.
 */
export function pickChatExamples(random: () => number = Math.random): ChatExampleQuestion[] {
  const pool = [...CHAT_EXAMPLE_QUESTIONS];
  // Fisher-Yates.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = pool[i];
    const b = pool[j];
    if (a === undefined || b === undefined) continue;
    pool[i] = b;
    pool[j] = a;
  }
  const { min, max } = CHAT_EXAMPLES_SHOWN;
  const count = Math.min(pool.length, min + Math.floor(random() * (max - min + 1)));
  return pool.slice(0, count);
}

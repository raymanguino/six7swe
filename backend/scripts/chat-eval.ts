/**
 * Runs the chat eval (#84): each seed question is answered once with the stuffed
 * context and once with the context retrieved from the knowledge service, and a
 * blind judge compares the two. Prints a Markdown report to attach to the PR.
 *
 * Both answers use the production chat prompt and model; only the context block
 * differs. The judge sees the full stuffed context as the reference.
 *
 * Usage:
 *   pnpm --filter @six7swe/backend chat:eval [--remote] [--out report.md]
 *
 * Environment (backend/.env, or backend/.env.remote with --remote):
 *   DATABASE_URL            the portfolio tables (profile and content sections)
 *   MINIMAX_API_KEY         answers and judging
 *   KNOWLEDGE_SERVICE_URL   the knowledge service, e.g. http://localhost:3100
 *   KNOWLEDGE_SERVICE_KEY   its service key
 *
 * The knowledge service must already hold the same background as the portfolio
 * tables (upload the resume and the content sections), or the comparison
 * measures a corpus gap rather than retrieval.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDatabaseTarget } from './db-env';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requireEnv(name: string): void {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} is not set. Add it to the backend env file or export it.`);
  }
}

async function main(): Promise<void> {
  resolveDatabaseTarget();
  requireEnv('MINIMAX_API_KEY');
  requireEnv('KNOWLEDGE_SERVICE_URL');
  requireEnv('KNOWLEDGE_SERVICE_KEY');

  // Imported after the env is loaded: `src/db` reads DATABASE_URL on load.
  const { getChatContext, getKnowledgeChatContext } = await import('../src/data/chatContext');
  const { getDefaultRetriever } = await import('../src/services/knowledgeRetrieval');
  const { buildChatMessages } = await import('../src/services/ai/chat');
  const { chatCompletion, structuredCompletion } = await import('../src/services/minimaxService');
  const { SEED_EVAL_QUESTIONS, JudgeVerdictSchema, buildJudgeMessages, renderEvalReport } =
    await import('../src/domain/chatEval');
  type EvalRow = import('../src/domain/chatEval').EvalRow;

  const retriever = getDefaultRetriever();
  if (!retriever) throw new Error('The knowledge retriever is not configured.');

  const stuffedContext = await getChatContext();
  const log = {
    warn: (obj: Record<string, unknown>, msg: string) =>
      process.stderr.write(`warn: ${msg} ${obj.err instanceof Error ? obj.err.message : ''}\n`),
  };

  const rows: EvalRow[] = [];
  for (const [i, question] of SEED_EVAL_QUESTIONS.entries()) {
    process.stderr.write(`[${i + 1}/${SEED_EVAL_QUESTIONS.length}] ${question.question}\n`);
    const retrieved = await getKnowledgeChatContext({
      message: question.question,
      history: question.history,
      retriever,
      log,
    });

    const answer = (context: string) =>
      chatCompletion(buildChatMessages(context, question.question, question.history), {
        reasoning_effort: 'medium',
      });
    const [stuffedAnswer, retrievedAnswer] = await Promise.all([
      answer(stuffedContext),
      answer(retrieved.context),
    ]);

    // Alternate which side is shown first, so position bias cancels out.
    const firstSide = i % 2 === 0 ? 'stuffed' : 'retrieved';
    const row: EvalRow = {
      question,
      stuffed: { answer: stuffedAnswer, contextChars: stuffedContext.length },
      retrieved: {
        answer: retrievedAnswer,
        contextChars: retrieved.context.length,
        chunkCount: retrieved.chunkCount,
        mode: retrieved.mode,
      },
      firstSide,
      verdict: null,
    };
    try {
      row.verdict = await structuredCompletion(
        buildJudgeMessages({
          reference: stuffedContext,
          question,
          answer1: firstSide === 'stuffed' ? stuffedAnswer : retrievedAnswer,
          answer2: firstSide === 'stuffed' ? retrievedAnswer : stuffedAnswer,
        }),
        JudgeVerdictSchema,
        { reasoning_effort: 'medium', max_tokens: 4096 },
      );
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
    }
    rows.push(row);
  }

  const report = renderEvalReport(rows, {
    generatedAt: new Date().toISOString(),
    model: 'the production chat model (MiniMax)',
  });
  const out = argValue('--out');
  if (out) {
    fs.writeFileSync(path.resolve(out), `${report}\n`);
    process.stderr.write(`Wrote ${path.resolve(out)}\n`);
  } else {
    process.stdout.write(`${report}\n`);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(
        `Chat eval failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}

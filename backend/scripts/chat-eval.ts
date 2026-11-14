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
  const { answerWithContext } = await import('../src/services/ai/chat');
  const { structuredCompletion } = await import('../src/services/minimaxService');
  const { SEED_EVAL_QUESTIONS, JudgeVerdictSchema, buildJudgeMessages, renderEvalReport } =
    await import('../src/domain/chatEval');
  type EvalRow = import('../src/domain/chatEval').EvalRow;

  const retriever = getDefaultRetriever();
  if (!retriever) throw new Error('The knowledge retriever is not configured.');

  const stuffedContext = await getChatContext();
  const log = {
    warn: (obj: Record<string, unknown>, msg: string) =>
      process.stderr.write(`warn: ${msg} ${JSON.stringify(obj.error ?? {})}\n`),
  };
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const rows: EvalRow[] = [];
  for (const [i, question] of SEED_EVAL_QUESTIONS.entries()) {
    process.stderr.write(`[${i + 1}/${SEED_EVAL_QUESTIONS.length}] ${question.question}\n`);
    // Alternate which side is shown first, so position bias cancels out.
    const firstSide = i % 2 === 0 ? 'stuffed' : 'retrieved';
    const row: EvalRow = {
      question,
      stuffed: { answer: null, contextChars: stuffedContext.length },
      retrieved: { answer: null, contextChars: 0, chunkCount: 0, outcome: null },
      firstSide,
      verdict: null,
    };
    rows.push(row);

    // One question failing is recorded on its row; the report is always written.
    try {
      const retrieved = await getKnowledgeChatContext({
        message: question.question,
        history: question.history,
        retriever,
        log,
      });
      row.retrieved.contextChars = retrieved.context.length;
      row.retrieved.chunkCount = retrieved.chunkCount;
      row.retrieved.outcome =
        retrieved.mode === 'retrieved'
          ? { mode: retrieved.mode }
          : { mode: retrieved.mode, reason: retrieved.reason };

      const [stuffedAnswer, retrievedAnswer] = await Promise.allSettled([
        answerWithContext(stuffedContext, question.question, question.history),
        answerWithContext(retrieved.context, question.question, question.history),
      ]);
      const errors: string[] = [];
      if (stuffedAnswer.status === 'fulfilled') row.stuffed.answer = stuffedAnswer.value;
      else errors.push(`stuffed answer: ${message(stuffedAnswer.reason)}`);
      if (retrievedAnswer.status === 'fulfilled') row.retrieved.answer = retrievedAnswer.value;
      else errors.push(`retrieved answer: ${message(retrievedAnswer.reason)}`);
      if (errors.length > 0) {
        row.error = errors.join('; ');
        continue;
      }

      const stuffed = row.stuffed.answer ?? '';
      const retrievedText = row.retrieved.answer ?? '';
      row.verdict = await structuredCompletion(
        buildJudgeMessages({
          reference: stuffedContext,
          question,
          answer1: firstSide === 'stuffed' ? stuffed : retrievedText,
          answer2: firstSide === 'stuffed' ? retrievedText : stuffed,
        }),
        JudgeVerdictSchema,
        { reasoning_effort: 'medium', max_tokens: 4096 },
      );
    } catch (error) {
      row.error = message(error);
    }
  }

  const report = renderEvalReport(rows, {
    generatedAt: new Date().toISOString(),
    model: 'the production chat model (MiniMax)',
  });
  const out = argValue('--out');
  if (out) {
    fs.writeFileSync(path.resolve(out), `${report}\n`);
    process.stderr.write(`Wrote ${path.resolve(out)}\n`);
    return;
  }
  // Exit only once stdout has flushed; a piped report is otherwise cut short.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${report}\n`, (err) => (err ? reject(err) : resolve()));
  });
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(
        `Chat eval failed: ${error instanceof Error ? error.message : String(error)}\n`,
        () => process.exit(1),
      );
    });
}

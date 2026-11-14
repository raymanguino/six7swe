/**
 * Runs the chat eval (#84): each seed question is answered once with the stuffed
 * context and once with the context retrieved from the knowledge service, and a
 * blind judge compares the two. Prints a Markdown report to attach to the PR.
 *
 * Both answers use the production chat prompt and model; only the context block
 * differs. The judge's reference is the stuffed context plus the extracted
 * text of every ready knowledge-service document (the resume PDF is only
 * there), each labeled. Without the owner key, or if fetching the documents
 * fails, the reference is the stuffed context only, and the report header and
 * stderr say so.
 *
 * Before anything else it waits for the knowledge service to answer /version (up to 30 s):
 * the chat:eval script rebuilds the knowledge-types package, which restarts a local
 * `tsx watch` service for a few seconds during which every connection is refused.
 *
 * Before the questions, one warm-up retrieval wakes the service, so a cold
 * first call does not knock out question 1. It is not part of the report.
 *
 * Usage:
 *   pnpm --filter @six7swe/backend chat:eval [--remote] [--out report.md]
 *
 * Environment (backend/.env, or backend/.env.remote with --remote):
 *   DATABASE_URL            the portfolio tables (profile and content sections)
 *   MINIMAX_API_KEY         answers and judging
 *   KNOWLEDGE_SERVICE_URL   the knowledge service, e.g. http://127.0.0.1:3100 (not
 *                           localhost, which Windows resolves to ::1 first)
 *   KNOWLEDGE_SERVICE_KEY   its service key
 *   KNOWLEDGE_OWNER_KEY     optional: its owner key, to read the documents for the
 *                           judge's full reference (stuffed context only without it)
 *   KNOWLEDGE_RETRIEVE_K    optional: chunks retrieved per question (default 6)
 *   KNOWLEDGE_TIMEOUT_MS    optional: per-request retrieval timeout (default 3000)
 *
 * The knowledge service must already hold the same background as the portfolio
 * tables (upload the resume and the content sections), or the comparison
 * measures a corpus gap rather than retrieval.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDatabaseTarget } from './db-env';

/** Reading whole documents is slower than a retrieval; this is a one-off, not a chat turn. */
const REFERENCE_TIMEOUT_MS = 15_000;

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
  const { getDefaultRetriever, resetDefaultRetriever } =
    await import('../src/services/knowledgeRetrieval');
  const { createKnowledgeDocumentClient } =
    await import('../src/services/knowledge/documentsClient');
  const { buildRetrievalQuery } = await import('../src/data/chatContext');
  const { answerWithContext } = await import('../src/services/ai/chat');
  const { structuredCompletion } = await import('../src/services/minimaxService');
  const {
    SEED_EVAL_QUESTIONS,
    JudgeVerdictSchema,
    buildJudgeMessages,
    buildJudgeReference,
    renderEvalReport,
  } = await import('../src/domain/chatEval');
  type EvalRow = import('../src/domain/chatEval').EvalRow;

  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const { awaitKnowledgeReady } = await import('../src/services/knowledge/awaitReady');
  const stuffedContext = await getChatContext();

  const ready = await awaitKnowledgeReady({
    baseUrl: process.env.KNOWLEDGE_SERVICE_URL ?? '',
    serviceKey: process.env.KNOWLEDGE_SERVICE_KEY ?? '',
    onWaiting: () =>
      process.stderr.write(
        'waiting for the knowledge service (it may be restarting after the types rebuild)...\n',
      ),
  });
  if (!ready.ready) {
    process.stderr.write(
      `\nWARNING: the knowledge service is not ready (${ready.reason}); continuing, ` +
        'so the reference fetch, warm-up and retrieval may fail.\n\n',
    );
  }

  // The judge's reference: the stuffed context plus every knowledge document.
  const ownerKey = process.env.KNOWLEDGE_OWNER_KEY?.trim();
  const reference = await buildJudgeReference({
    stuffedContext,
    documents: ownerKey
      ? createKnowledgeDocumentClient({
          baseUrl: process.env.KNOWLEDGE_SERVICE_URL ?? '',
          ownerKey,
          timeoutMs: REFERENCE_TIMEOUT_MS,
        })
      : null,
  });
  if (reference.stuffedOnlyReason) {
    process.stderr.write(
      `\nWARNING: the judge's reference is the stuffed context only (${reference.stuffedOnlyReason}).\n` +
        'Answers citing facts found only in the knowledge documents (such as the resume PDF) may be scored as invented.\n\n',
    );
  }
  process.stderr.write(
    `Judge reference: ${reference.sources.map((s) => `${s.label} (${s.chars} chars)`).join('; ')}\n`,
  );
  if (reference.skipped.length > 0) {
    process.stderr.write(`Left out (no extracted text): ${reference.skipped.join('; ')}\n`);
  }

  // Warm-up: the first call to a cold service can time out and knock out
  // question 1. On failure the retriever is rebuilt, so its failure cooldown
  // does not fail question 1 fast as well.
  const warmUpRetriever = getDefaultRetriever();
  if (!warmUpRetriever) throw new Error('The knowledge retriever is not configured.');
  const warmUp = SEED_EVAL_QUESTIONS[0];
  if (warmUp) {
    try {
      await warmUpRetriever.retrieve(buildRetrievalQuery(warmUp.question, warmUp.history));
    } catch (error) {
      process.stderr.write(`warn: warm-up retrieval failed, continuing: ${message(error)}\n`);
      resetDefaultRetriever();
    }
  }
  const retriever = getDefaultRetriever();
  if (!retriever) throw new Error('The knowledge retriever is not configured.');

  const log = {
    warn: (obj: Record<string, unknown>, msg: string) =>
      process.stderr.write(`warn: ${msg} ${JSON.stringify(obj.error ?? {})}\n`),
  };

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
          reference: reference.text,
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
    reference,
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

import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDrizzleEvalRepository } from './db/api/drizzleEvalRepository.js';
import { createDrizzleProfileRepository } from './db/api/drizzleProfileRepository.js';
import { createEvalAnswerer } from './services/evalSet/answerer.js';
import { RUN_INTERRUPTED } from './services/evalSet/runner.js';
import { createDrizzleRepository } from './db/api/drizzleRepository.js';
import { createDb } from './db/index.js';
import { EMBEDDING_DIMENSIONS } from './db/schema.js';
import { createEmbedder } from './services/embedding/index.js';
import { createProfileDrafter } from './services/profile/drafter.js';
import { createFileStore } from './services/storage/index.js';
import { createShutdown } from './shutdown.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);
  const repo = createDrizzleRepository(db);
  const files = createFileStore(env.fileStore);
  const embedder = createEmbedder(env.embedder, EMBEDDING_DIMENSIONS);
  const drafter = createProfileDrafter(env.profileDrafter);
  const evalRepo = createDrizzleEvalRepository(db);
  const answerer = createEvalAnswerer(env.evalAnswerer);

  // Runs cut off by the last shutdown never finish; say so instead of "running" forever.
  const abandoned = await evalRepo.abandonRunning(RUN_INTERRUPTED);

  const app = await buildApp({
    deps: { repo, files, embedder },
    profile: { repo: createDrizzleProfileRepository(db), drafter },
    evaluation: {
      repo: evalRepo,
      answerer,
      settings: {
        ...(env.EVAL_GAP_SIMILARITY === undefined
          ? {}
          : { gapSimilarity: env.EVAL_GAP_SIMILARITY }),
        ...(env.EVAL_OFF_TOPIC_SIMILARITY === undefined
          ? {}
          : { offTopicSimilarity: env.EVAL_OFF_TOPIC_SIMILARITY }),
      },
    },
    serviceKey: env.KNOWLEDGE_SERVICE_KEY,
    ownerKey: env.KNOWLEDGE_OWNER_KEY,
    mcpKey: env.KNOWLEDGE_MCP_KEY,
    ownerId: env.OWNER_AUTH_ID,
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
  });
  const queue = app.ingestionQueue;

  app.log.info(
    {
      embedder: embedder.name,
      files: files.name,
      profileDrafter: drafter?.name ?? 'off',
      evalAnswerer: answerer?.name ?? 'off',
    },
    'Knowledge service configured',
  );
  if (abandoned > 0) app.log.warn({ count: abandoned }, 'Marked interrupted eval runs failed');

  if (env.RESUME_INGESTION_ON_BOOT) {
    const unfinished = await repo.listUnfinished();
    for (const doc of unfinished) queue.enqueue(doc);
    if (unfinished.length > 0) {
      app.log.warn({ count: unfinished.length }, 'Re-queued unfinished documents');
    }
  }

  const shutdown = createShutdown({
    closeApp: () => app.close(),
    // Drafting is not durable: a draft cut off here is not written, and the
    // owner can ask for another.
    // Eval recording and runs are not durable either: a question cut off here
    // is not recorded, and a run cut off is marked failed on the next boot.
    stopQueue: () =>
      Promise.all([
        queue.stop(),
        app.profileDrafting.stop(),
        app.evalSet.stop(),
        app.evalRunner.stop(),
      ]),
    closeDb: close,
    log: app.log,
    exit: (code) => process.exit(code),
  });
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

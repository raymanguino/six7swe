import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDrizzleRepository } from './db/api/drizzleRepository.js';
import { createDb } from './db/index.js';
import { EMBEDDING_DIMENSIONS } from './db/schema.js';
import { createEmbedder } from './services/embedding/index.js';
import { createFileStore } from './services/storage/index.js';

/**
 * How long shutdown waits for the document being ingested. Railway sends
 * SIGKILL 30s after SIGTERM by default; this leaves room to close the pool.
 * A document cut off here stays `processing` and is re-queued on next boot.
 */
const SHUTDOWN_TIMEOUT_MS = 20_000;

/** Resolves true if `promise` settles in time, false if the timeout wins. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);
  const repo = createDrizzleRepository(db);
  const files = createFileStore(env);
  const embedder = createEmbedder(env, EMBEDDING_DIMENSIONS);

  const app = await buildApp({
    deps: { repo, files, embedder },
    serviceKey: env.KNOWLEDGE_SERVICE_KEY,
    ownerId: env.OWNER_AUTH_ID,
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
  });
  const queue = app.ingestionQueue;

  app.log.info({ embedder: embedder.name, files: files.name }, 'Knowledge service configured');

  if (env.RESUME_INGESTION_ON_BOOT) {
    const unfinished = await repo.listUnfinished();
    for (const doc of unfinished) queue.enqueue(doc);
    if (unfinished.length > 0) {
      app.log.warn({ count: unfinished.length }, 'Re-queued unfinished documents');
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    try {
      // Stop accepting requests first, so no upload enqueues behind the stop.
      await app.close();
      const stopped = queue.stop();
      if (!(await settlesWithin(stopped, SHUTDOWN_TIMEOUT_MS))) {
        app.log.warn(
          { timeoutMs: SHUTDOWN_TIMEOUT_MS },
          'Ingestion did not finish in time; it resumes on next boot',
        );
      }
      await close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

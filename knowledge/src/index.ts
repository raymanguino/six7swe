import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDrizzleRepository } from './db/api/drizzleRepository.js';
import { createDb } from './db/index.js';
import { EMBEDDING_DIMENSIONS } from './db/schema.js';
import { createEmbedder } from './services/embedding/index.js';
import { createFileStore } from './services/storage/index.js';
import { createShutdown } from './shutdown.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);
  const repo = createDrizzleRepository(db);
  const files = createFileStore(env.fileStore);
  const embedder = createEmbedder(env.embedder, EMBEDDING_DIMENSIONS);

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

  const shutdown = createShutdown({
    closeApp: () => app.close(),
    stopQueue: () => queue.stop(),
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

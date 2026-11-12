import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDrizzleRepository } from './db/api/drizzleRepository.js';
import type { DocumentRecord } from './db/api/repository.js';
import { createDb } from './db/index.js';
import { EMBEDDING_DIMENSIONS } from './db/schema.js';
import { createEmbedder } from './services/embedding/index.js';
import { ingestDocument } from './services/ingestion/pipeline.js';
import { SerialQueue } from './services/ingestion/queue.js';
import { createFileStore } from './services/storage/index.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);
  const repo = createDrizzleRepository(db);
  const files = createFileStore(env);
  const embedder = createEmbedder(env, EMBEDDING_DIMENSIONS);

  // The queue needs a logger before the app exists; it is assigned below.
  let log: import('fastify').FastifyBaseLogger | undefined;
  const queue = new SerialQueue<DocumentRecord>(
    (doc) => {
      if (!log) throw new Error('logger not ready');
      return ingestDocument({ repo, files, embedder, log }, doc);
    },
    (doc, error) => log?.error({ documentId: doc.id, err: error }, 'Ingestion worker crashed'),
  );

  const app = await buildApp({
    serviceKey: env.KNOWLEDGE_SERVICE_KEY,
    context: {
      repo,
      files,
      embedder,
      queue,
      ownerId: env.OWNER_AUTH_ID,
      maxUploadBytes: env.MAX_UPLOAD_BYTES,
    },
  });
  log = app.log;

  app.log.info({ embedder: embedder.name, files: files.name }, 'Knowledge service configured');

  if (env.RESUME_INGESTION_ON_BOOT) {
    const unfinished = await repo.listUnfinished();
    for (const doc of unfinished) queue.enqueue(doc);
    if (unfinished.length > 0) {
      app.log.warn({ count: unfinished.length }, 'Re-queued unfinished documents');
    }
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    await close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

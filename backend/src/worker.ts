import 'dotenv/config';

import pino from 'pino';
import { assertKnowledgeRetrievalConfigured } from './config/knowledgeRetrieval';
import { dropMigrationUrl } from './config/migrationUrl';
import {
  loadWorkerConfig,
  WORKER_POLL_MS,
  WORKER_SCHEDULE_MS,
  WORKER_SHUTDOWN_GRACE_MS,
} from './config/worker';

/**
 * The scraper worker, Railway's `@six7swe/job-worker`: a reduced variable set
 * (`config/worker.ts`) and the worker role (`db/workerRole.ts`). It runs every
 * refresh; how, and why never two at once, is in `services/jobHunt/refreshWorker.ts`.
 */

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.headers["x-brain-key"]',
      'res.headers["set-cookie"]',
    ],
    remove: true,
  },
});

async function main(): Promise<void> {
  // Checked before anything that reads the environment at load time (the database client) is
  // imported, so a missing or forbidden variable fails with one clear message.
  const config = loadWorkerConfig();
  assertKnowledgeRetrievalConfigured();
  // Only reachable outside production, where a local .env may carry the owner's URL.
  dropMigrationUrl();

  const [
    { createStandaloneRefreshWorker },
    { runWorkerLoop },
    { startStaleRefreshReaper },
    { assertWorkerRoleIsSafe },
  ] = await Promise.all([
    import('./services/jobHunt/standalone'),
    import('./services/jobHunt/refreshWorker'),
    import('./services/jobHunt/staleRefreshReaper'),
    import('./services/databaseRole'),
  ]);

  if (process.env.NODE_ENV === 'production') await assertWorkerRoleIsSafe();

  await startStaleRefreshReaper(logger);

  const worker = createStandaloneRefreshWorker(
    { ...config, scheduleEveryMs: WORKER_SCHEDULE_MS },
    logger,
  );

  logger.info(
    { profileIds: config.profileIds, intervalHours: config.intervalMs / 3_600_000 },
    config.profileIds.length > 0
      ? 'Job worker started'
      : 'Job worker started with no JOB_REFRESH_PROFILE_IDS: queued refreshes only',
  );

  // On a stop signal nothing new is claimed; the run in progress gets a grace period, then is
  // failed under this worker's claim so its profile is free at once.
  const shutdown = new AbortController();
  const stop = (signal: string): void => {
    logger.info({ signal }, 'Job worker stopping');
    shutdown.abort();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));

  await runWorkerLoop({
    worker,
    pollMs: WORKER_POLL_MS,
    signal: shutdown.signal,
    graceMs: WORKER_SHUTDOWN_GRACE_MS,
    logger,
  });
  logger.info('Job worker stopped');
  process.exit(0);
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Job worker failed to start');
  process.exit(1);
});

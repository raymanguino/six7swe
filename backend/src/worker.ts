import 'dotenv/config';

import pino from 'pino';
import { assertKnowledgeRetrievalConfigured } from './config/knowledgeRetrieval';
import { dropMigrationUrl } from './config/migrationUrl';
import { loadWorkerConfig, WORKER_TICK_MS } from './config/worker';

/**
 * The scraper worker (#243), Railway's `@six7swe/job-worker`: a reduced
 * variable set (`config/worker.ts`) and the worker role (`db/workerRole.ts`).
 * Long-lived rather than a cron, so queue polling (#254) can join the loop.
 */

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

async function main(): Promise<void> {
  // Checked before anything that reads the environment at load time (the database client) is
  // imported, so a missing or forbidden variable fails with one clear message.
  const config = loadWorkerConfig();
  assertKnowledgeRetrievalConfigured();
  // Only reachable outside production, where a local .env may carry the owner's URL.
  dropMigrationUrl();

  const [
    { createStandaloneRefreshScheduler, reapStaleRefreshes, startStaleRefreshReaper },
    { assertWorkerRoleIsSafe },
  ] = await Promise.all([
    import('./services/jobHunt/standalone'),
    import('./services/databaseRole'),
  ]);

  if (process.env.NODE_ENV === 'production') await assertWorkerRoleIsSafe();

  // Heartbeat-based, so it never fails a refresh another process is still running.
  const reaped = await reapStaleRefreshes();
  if (reaped > 0) logger.info({ reaped }, 'Reaped stale refreshes');
  startStaleRefreshReaper(logger);

  const scheduler = createStandaloneRefreshScheduler(config, logger);

  logger.info(
    { profileIds: config.profileIds, intervalHours: config.intervalMs / 3_600_000 },
    config.profileIds.length > 0
      ? 'Job worker started'
      : 'Job worker started with no JOB_REFRESH_PROFILE_IDS: no scheduled refreshes',
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = async (): Promise<void> => {
    try {
      await scheduler.tick();
    } catch (error) {
      // A database or network blip must not end the worker; the next tick tries again.
      logger.error({ err: error }, 'Scheduled refresh tick failed');
    }
    timer = setTimeout(() => void loop(), WORKER_TICK_MS);
  };

  const stop = (signal: string): void => {
    logger.info({ signal }, 'Job worker stopping');
    if (timer) clearTimeout(timer);
    // A refresh cut off here stops heartbeating, so stale-claim recovery marks it failed.
    process.exit(0);
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));

  await loop();
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Job worker failed to start');
  process.exit(1);
});

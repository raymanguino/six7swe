import 'dotenv/config';

import pino from 'pino';
import { assertKnowledgeRetrievalConfigured } from './config/knowledgeRetrieval';
import { dropMigrationUrl } from './config/migrationUrl';
import { loadWorkerConfig, WORKER_TICK_MS } from './config/worker';

/**
 * The scraper worker (#243): the Railway service `@six7swe/job-worker`, and
 * the only service meant to launch Chrome once #254 moves user-triggered
 * refreshes here. It holds a reduced variable set (`config/worker.ts`) and
 * connects as the worker role, which reaches only the refresh's tables
 * (`db/workerRole.ts`).
 *
 * It is long-lived rather than a cron that exits, so queue polling can join
 * the scheduled refresh in the same loop.
 *
 * Usage: pnpm start:worker (production build) or pnpm worker:dev.
 */

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

async function main(): Promise<void> {
  // Checked before anything that reads the environment at load time (the database client) is
  // imported, so a missing or forbidden variable fails with one clear message.
  const config = loadWorkerConfig();
  assertKnowledgeRetrievalConfigured();
  // Only reachable outside production, where a local .env may carry the owner's URL.
  dropMigrationUrl();

  const [{ createStandaloneJobRefreshService, reapStaleRefreshes }, refreshStatus, role, sched] =
    await Promise.all([
      import('./services/jobHunt/standalone'),
      import('./db/api/refreshStatus'),
      import('./db/api/runtimeRole'),
      import('./services/jobHunt/refreshScheduler'),
    ]);

  if (process.env.NODE_ENV === 'production') {
    await role.assertConnectionRoleIsSafe();
  }

  const scheduler = sched.createRefreshScheduler(config, {
    service: createStandaloneJobRefreshService(),
    getLatestRefreshStartedAt: refreshStatus.getLatestRefreshStartedAt,
    getRefreshStatus: refreshStatus.getRefreshStatus,
    reapStaleRefreshes: () => reapStaleRefreshes(),
    logger,
  });

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
    // A refresh cut off here stays active until the stale-refresh reaper marks it failed.
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

import { FastifyInstance } from 'fastify';
import { PRIVATE_ROUTE } from './access';
import * as jobHandlers from './handlers/jobHandlers';
import * as profileHandlers from './handlers/profileHandlers';
import * as profileJobHandlers from './handlers/profileJobHandlers';
import * as userHandlers from './handlers/userHandlers';

interface ProfileParams {
  profileId: string;
}

interface RefreshParams extends ProfileParams {
  refreshId: string;
}

/**
 * Job-hunter product.
 *
 * Scoped under `/job-hunt/*` to keep it clearly separated from the public
 * portfolio surface. Every route here requires authentication unless it
 * explicitly opts out; `PRIVATE_ROUTE` is stated per route so that changing
 * the default never silently widens access.
 */
export async function registerJobHuntRoutes(app: FastifyInstance): Promise<void> {
  // Job postings
  app.get('/job-hunt/jobs', PRIVATE_ROUTE, jobHandlers.getAllJobs);
  app.get<{ Params: { source_id: string; source_job_id: string } }>(
    '/job-hunt/jobs/:source_id/:source_job_id',
    PRIVATE_ROUTE,
    jobHandlers.getJobBySourceId,
  );

  // Search profiles
  app.get('/job-hunt/profiles', PRIVATE_ROUTE, profileHandlers.getAllProfiles);
  app.post('/job-hunt/profiles', PRIVATE_ROUTE, profileHandlers.createProfileHandler);
  app.get<{ Params: ProfileParams }>(
    '/job-hunt/profiles/:profileId',
    PRIVATE_ROUTE,
    profileHandlers.getProfileById,
  );
  app.patch<{ Params: ProfileParams }>(
    '/job-hunt/profiles/:profileId',
    PRIVATE_ROUTE,
    profileHandlers.updateProfileHandler,
  );
  app.delete<{ Params: ProfileParams }>(
    '/job-hunt/profiles/:profileId',
    PRIVATE_ROUTE,
    profileHandlers.deleteProfileHandler,
  );

  // Profile job matches
  app.get<{ Params: ProfileParams }>(
    '/job-hunt/profiles/:profileId/jobs',
    PRIVATE_ROUTE,
    profileJobHandlers.getJobsForProfile,
  );

  // Refresh pipeline
  app.post<{ Params: ProfileParams }>(
    '/job-hunt/profiles/:profileId/jobs/refresh',
    PRIVATE_ROUTE,
    profileJobHandlers.runRefreshJobsForProfile,
  );
  app.get<{ Params: RefreshParams }>(
    '/job-hunt/profiles/:profileId/jobs/refresh/:refreshId',
    PRIVATE_ROUTE,
    profileJobHandlers.getRefreshStatus,
  );

  // Users
  app.get('/job-hunt/users', PRIVATE_ROUTE, userHandlers.getCurrentUser);
  app.get<{ Params: { id: string } }>(
    '/job-hunt/users/:id',
    PRIVATE_ROUTE,
    userHandlers.getUserById,
  );
}

import { FastifyInstance } from 'fastify';
import * as jobHandlers from './handlers';
import * as profileHandlers from './handlers';
import * as profileJobHandlers from './handlers';
import * as userHandlers from './handlers';

export * from './currentUser'

interface ProfileParams {
  profileId: number;
}

interface RefreshParams extends ProfileParams {
  refreshId: number;
}

export default async function registerRoutes(service: FastifyInstance) {
  service.get('/jobs', jobHandlers.getAllJobs);
  service.get('/jobs/:source_id/:source_job_id', jobHandlers.getJobBySourceId);
  service.post<{ Params: ProfileParams}>('/profiles/:profileId/jobs/refresh', profileJobHandlers.runRefreshJobsForProfile);
  service.get<{ Params: RefreshParams}>('/profiles/:profileId/jobs/refresh/:refreshId', profileJobHandlers.getRefreshStatus);
  service.get<{ Params: ProfileParams}>('/profiles/:profileId/jobs', profileJobHandlers.getJobsForProfile);
  service.get('/profiles', profileHandlers.getAllProfiles);
  service.get('/profiles/:profileId', profileHandlers.getProfileById);
  service.get('/users', userHandlers.getAllUsers);
  service.get('/users/:id', userHandlers.getUserById);
};

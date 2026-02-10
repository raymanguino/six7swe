import { FastifyInstance } from 'fastify';
import * as jobHandlers from './handlers/jobHandlers';
import * as profileHandlers from './handlers/profileHandlers';
import * as profileJobHandlers from './handlers/profileJobHandlers';
import * as userHandlers from './handlers/userHandlers';
import * as chatHandlers from './handlers/chatHandlers';
import * as jobMatchHandlers from './handlers/jobMatchHandlers';
import * as fitcheckHandlers from './handlers/fitcheckHandlers';
import * as contactHandlers from './handlers/contactHandlers';
import * as portfolioHandlers from './handlers/portfolioHandlers';
import * as resumeHandlers from './handlers/resumeHandlers';

export * from './currentUser'

interface ProfileParams {
  profileId: number;
}

interface RefreshParams extends ProfileParams {
  refreshId: number;
}

export default async function registerRoutes(service: FastifyInstance) {
  // Public portfolio routes
  service.get('/portfolio', portfolioHandlers.getPortfolioHandler);
  service.get('/resume', resumeHandlers.resumeHandler);
  service.post('/chat', chatHandlers.chatHandler);
  service.post('/job-match', jobMatchHandlers.jobMatchHandler);
  service.post('/fitcheck', fitcheckHandlers.fitcheckHandler);
  service.post('/contact', contactHandlers.contactHandler);
  
  // Existing job routes (public for portfolio)
  service.get('/jobs', jobHandlers.getAllJobs);
  service.get('/jobs/:source_id/:source_job_id', jobHandlers.getJobBySourceId);
  
  // Protected routes (require authentication)
  service.post<{ Params: ProfileParams}>('/profiles/:profileId/jobs/refresh', profileJobHandlers.runRefreshJobsForProfile);
  service.get<{ Params: RefreshParams}>('/profiles/:profileId/jobs/refresh/:refreshId', profileJobHandlers.getRefreshStatus);
  service.get<{ Params: ProfileParams}>('/profiles/:profileId/jobs', profileJobHandlers.getJobsForProfile);
  service.get('/profiles', profileHandlers.getAllProfiles);
  service.get('/profiles/:profileId', profileHandlers.getProfileById);
  service.get('/users', userHandlers.getAllUsers);
  service.get('/users/:id', userHandlers.getUserById);
};

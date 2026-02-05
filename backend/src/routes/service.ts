import { JobFetchService } from '../services/jobFetchers';
import { RefreshStatusService } from '../database/api';
import { ProfileService } from '../database/api';
import { JobService } from '../database/api';
import { JobMatchEvaluatorService } from '../services/agents';
import * as profileJobService from '../database/api';

export interface SixSevenService {
  jobFetchService: JobFetchService;
  refreshStatusService: RefreshStatusService;
  profileService: ProfileService;
  profileJobService: profileJobService.ProfileJobService;
  jobService: JobService;
  agentServices: JobMatchEvaluatorService;
}

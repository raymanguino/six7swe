import { JobFetchService } from '../services/jobFetchers';
import { RefreshStatusService } from '../db/api';
import { ProfileService } from '../db/api';
import { JobService } from '../db/api';
import * as profileJobService from '../db/api';
import { JobMatchEvaluatorService } from '../services/agents';

export interface SixSevenService {
  jobFetchService: JobFetchService;
  refreshStatusService: RefreshStatusService;
  profileService: ProfileService;
  profileJobService: profileJobService.ProfileJobService;
  jobService: JobService;
  agentServices: JobMatchEvaluatorService;
}

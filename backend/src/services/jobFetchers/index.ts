import type { JobInput } from '../../db/api/job';
import { LinkedIn } from './linkedin';

export * from './browser';
export * from './page';
export * from './linkedin';

export interface JobFetchService {
  runJobFetch(
    keywords: Array<string>,
    location: string,
    fetchedJobsCallback: (jobs: Array<JobInput>) => void,
    statusCallback?: (status: string) => void,
    successCallback?: (summary?: string) => void,
    failureCallback?: (error?: string) => void,
  ): Promise<void>;
}

export interface JobFetcherSearchResults {
  source: string;
  jobs: Array<Partial<JobInput>>;
}

export interface JobFetcher {
  fetchSearchResults(
    keywords: Array<string>,
    location: string,
    pageNum: number,
  ): Promise<JobFetcherSearchResults>;

  fetchFullJobDetails(
    jobs: Array<Partial<JobInput>>,
    options: { concurrency?: number; retries?: number },
    fetchedJobsCallback: (jobs: Array<JobInput>) => void,
    statusCallback?: (status: string) => void,
  ): Promise<Array<JobInput>>;
}

export async function runJobFetch(
  keywords: Array<string> = [],
  location: string,
  fetchedJobsCallback: (fetchedJobs: Array<JobInput>) => void,
  statusCallback?: (status: string) => void,
  successCallback?: (summary?: string) => void,
  failureCallback?: (error?: string) => void,
): Promise<void> {
  try {
    const fetchers: Array<JobFetcher> = [
      new LinkedIn()
    ];
    
    statusCallback?.(`Fetching jobs...`);
    const searchResultsList = await Promise.all(fetchers.map(fetcher => fetcher.fetchSearchResults(keywords, location, 0)));
    
    statusCallback?.([
      `Fetched a total of ${searchResultsList.reduce((acc, list) => acc + list.jobs.length, 0)} jobs from all sources.`,
      `Fetching full job details...`
    ].join(' '));
    const fetchedJobs = await Promise.all(searchResultsList.map(searchResults => {
      const fetcher = fetchers.find(f => f.constructor.name === searchResults.source);
      if (!fetcher) {
        throw new Error(`No fetcher found for source: ${searchResults.source}`);
      }
      return fetcher.fetchFullJobDetails(searchResults.jobs, {
        concurrency: 1,
        retries: 3
      }, fetchedJobsCallback, statusCallback);
    }));

    const summary: Array<string> = [];
    summary.push(`Job fetch completed.`);
    summary.push(`Total jobs fetched: ${fetchedJobs.reduce((acc, list) => acc + (list?.length || 0), 0)}`);

    successCallback?.(summary.join(' '));
  } catch (error) {
    console.error('Error executing job fetch:', error);
    failureCallback?.('Error executing job fetch.');
  }
}

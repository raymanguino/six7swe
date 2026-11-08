import type { FastifyBaseLogger } from 'fastify';
import type { JobInput } from '../../db/api/job';
import { LinkedIn } from './linkedin';

export * from './browser';
export * from './page';
export * from './linkedin';

/** Default number of job detail pages fetched in parallel. */
export const DEFAULT_FETCH_CONCURRENCY = 3;

/** Default number of attempts per job detail page. */
export const DEFAULT_FETCH_RETRIES = 3;

/**
 * Fetches job postings from the configured sources.
 *
 * `onJobsFetched` is awaited, so the caller knows a batch has been fully
 * persisted and scored before the fetch moves on. This is what stops a
 * refresh from being reported as complete while its last batch is still
 * being written.
 */
export interface JobFetchService {
  runJobFetch(
    keywords: Array<string>,
    geoId: string,
    onJobsFetched: (jobs: Array<JobInput>) => void | Promise<void>,
    onStatus?: (status: string) => void | Promise<void>,
  ): Promise<void>;
}

export interface JobFetcherSearchResults {
  source: string;
  jobs: Array<Partial<JobInput>>;
}

export interface JobFetcher {
  fetchSearchResults(
    keywords: Array<string>,
    geoId: string,
    pageNum: number,
  ): Promise<JobFetcherSearchResults>;

  fetchFullJobDetails(
    jobs: Array<Partial<JobInput>>,
    options: { concurrency?: number; retries?: number },
    onJobsFetched: (jobs: Array<JobInput>) => void | Promise<void>,
    onStatus?: (status: string) => void | Promise<void>,
  ): Promise<Array<JobInput>>;

  /** Releases any resources held by the fetcher. */
  close(): Promise<void>;
}

/**
 * Runs a full fetch across every configured source.
 *
 * Errors propagate to the caller: the refresh pipeline is responsible for
 * recording the failure, so a fetch that fails is never reported as a
 * success.
 */
export async function runJobFetch(
  keywords: Array<string>,
  geoId: string,
  onJobsFetched: (jobs: Array<JobInput>) => void | Promise<void>,
  onStatus?: (status: string) => void | Promise<void>,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const fetchers: Array<JobFetcher> = [new LinkedIn()];

  try {
    await onStatus?.('Fetching jobs...');

    const searchResultsList = await Promise.all(
      fetchers.map((fetcher) => fetcher.fetchSearchResults(keywords, geoId, 0)),
    );

    const totalFound = searchResultsList.reduce((acc, list) => acc + list.jobs.length, 0);
    await onStatus?.(
      `Fetched a total of ${totalFound} jobs from all sources. Fetching full job details...`,
    );

    await Promise.all(
      searchResultsList.map(async (searchResults) => {
        const fetcher = fetchers.find((f) => f.constructor.name === searchResults.source);
        if (!fetcher) {
          throw new Error(`No fetcher found for source: ${searchResults.source}`);
        }

        await fetcher.fetchFullJobDetails(
          searchResults.jobs,
          { concurrency: DEFAULT_FETCH_CONCURRENCY, retries: DEFAULT_FETCH_RETRIES },
          onJobsFetched,
          onStatus,
        );
      }),
    );

    logger?.info({ keywords, geoId }, 'Job fetch completed');
  } finally {
    await Promise.all(fetchers.map((fetcher) => fetcher.close()));
  }
}

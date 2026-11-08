import { Browser } from 'puppeteer';
import type { JobInput } from '../../../db/api/job';
import { retry } from '../../../util';
import { JobFetcher, JobFetcherSearchResults, newBrowser, newPage } from '..';
import { buildLinkedInJobListUrl, sanitizeJobLink } from './url';
import * as scraper from './scraper';

export interface LinkedInJobFetcherOptions {
  concurrency?: number;
  retries?: number;
}

/**
 * LinkedIn job fetcher.
 *
 * Holds a single browser for the whole fetch. The previous implementation
 * launched a fresh Chromium for the search and again for every batch, which
 * meant one browser launch per job.
 */
export class LinkedIn implements JobFetcher {
  private browser: Browser | null = null;

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await newBrowser();
    }
    return this.browser;
  }

  async fetchSearchResults(
    keywords: Array<string>,
    geoId: string,
    pageNum: number = 0,
  ): Promise<JobFetcherSearchResults> {
    const listUrl = buildLinkedInJobListUrl(keywords, geoId, pageNum);
    const browser = await this.getBrowser();
    const page = await newPage(browser);

    try {
      await page.goto(listUrl, { waitUntil: 'networkidle2' });
      const jobs = await scraper.jobListFromPage(page);

      for (const job of jobs) {
        if (job.link) {
          job.link = sanitizeJobLink(job.link);
        }
      }

      return { source: this.constructor.name, jobs };
    } finally {
      await page.close();
    }
  }

  async fetchFullJobDetails(
    jobs: Array<Partial<JobInput>>,
    options: LinkedInJobFetcherOptions,
    onJobsFetched: (jobs: Array<JobInput>) => void | Promise<void>,
    onStatus?: (status: string) => void | Promise<void>,
  ): Promise<Array<JobInput>> {
    const { concurrency = 3, retries = 3 } = options;
    const results: Array<JobInput> = [];

    let i = 0;
    while (i < jobs.length) {
      const batch = jobs.slice(i, i + concurrency);

      const fetched = await this.fetchJobs(batch, retries);

      for (const job of batch) {
        job.source_id = this.constructor.name;
      }

      // Awaited: the caller persists and scores the batch, and the fetch must
      // not report progress past work that is still in flight.
      await onJobsFetched(fetched);

      results.push(...fetched);

      i += concurrency;

      await onStatus?.(
        `Fetched ${Math.min(i, jobs.length)}/${jobs.length} jobs from ${this.constructor.name}.`,
      );
    }

    return results;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private async fetchJobs(
    jobs: Array<Partial<JobInput>>,
    retries: number,
  ): Promise<Array<JobInput>> {
    const browser = await this.getBrowser();
    const results: Array<JobInput> = [];

    await Promise.all(
      jobs.map(async (job) => {
        try {
          await retry(async () => {
            const page = await newPage(browser);
            try {
              const detailedJob = await scraper.jobDetailsFromPage(job, page);
              if (detailedJob) {
                results.push(detailedJob);
              }
            } finally {
              await page.close();
            }
          }, retries);
        } catch {
          // A single posting that cannot be read must not fail the whole
          // refresh; it is simply omitted from this batch.
        }
      }),
    );

    return results;
  }
}

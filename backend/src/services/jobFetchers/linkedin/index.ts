import { Browser, Page } from 'puppeteer';
import { Job } from '../../../types';
import { retry } from '../../../util';
import { JobFetcher, JobFetcherSearchResults, newBrowser, newPage } from '..';
import { buildLinkedInJobListUrl, sanitizeJobLink } from './url';
import * as scraper  from './scraper';

export interface LinkedInJobFetcherOptions {
  concurrency?: number;
  retries?: number;
}

export class LinkedIn implements JobFetcher {
  async fetchSearchResults(
    keywords: Array<string>,
    location: string,
    pageNum: number = 0,
  ): Promise<JobFetcherSearchResults> {
    const jobs = await fetchJobList(keywords, location, pageNum);

    jobs.forEach(job => {
      if (job.link) {
        job.link = sanitizeJobLink(job.link);
      }
    });

    return { 
      source: this.constructor.name,
      jobs
    };
  }

  async fetchFullJobDetails(
    jobs: Array<Partial<Job>>,
    options: LinkedInJobFetcherOptions,
    fetchedJobsCallback: (jobs: Array<Job>) => void,
    statusCallback?: (status: string) => void,
  ): Promise<Array<Job>> {
    const { 
      concurrency = 5, 
      retries = 3 
    } = options;
    let results: Array<Job> = [];

    let i = 0;
    while (i < jobs.length) {
      const batch = jobs.slice(i, i + concurrency);

      const fetched = await fetchJobs(batch, retries);

      jobs.forEach(job => {
        job.source_id = this.constructor.name;
      });

      fetchedJobsCallback(fetched);

      results.push(...fetched);

      i += concurrency;

      statusCallback?.(`Fetched ${Math.min(i, jobs.length)}/${jobs.length} jobs from ${this.constructor.name}.`);
    }

    return results;
  }
}

async function fetchJobList(
  keywords: Array<string> = [],
  location: string,
  pageNum: number = 0,
): Promise<Array<Partial<Job>>> {
  const linkedListUrl = buildLinkedInJobListUrl(keywords, location, pageNum);
  
  console.log('LinkedIn Job List URL:', linkedListUrl);

  const browser: Browser = await newBrowser();
  const page: Page = await newPage(browser);

  try {
    await page.goto(linkedListUrl, { waitUntil: 'networkidle2' });

    return await scraper.jobListFromPage(page);
  } catch (error) {
    console.error('Error fetching LinkedIn job IDs:', error);
    throw error;
  } finally {
    await page.close();
    await browser.close();
  }
}

async function fetchJobs(
  jobs: Array<Partial<Job>>, 
  retries = 3
) : Promise<Array<Job>> {
  const results: Array<Job> = [];
  const browser = await newBrowser();

  try {
    await Promise.all(jobs.map(async job => {
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
      } catch (error) {
        console.error(`Failed to fetch job details for job ID ${job.id}:`, error);
      }
    }));
  } finally {
    await browser.close();
  }

  return results;
}

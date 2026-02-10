import { Page } from 'puppeteer';
import type { JobInput } from '../../../db/api/job';

export async function jobListFromPage(
  page: Page
): Promise<Array<Partial<JobInput>>> {

  const jobCardsSelector = '.base-card';
  await page.waitForSelector(jobCardsSelector, { timeout: 10000 });

  const jobs = await page.evaluate((selector) => {
    const attribute = 'data-entity-urn';
    const jobElements = document.querySelectorAll(selector);

    const result: Array<Partial<JobInput>> = [];

    jobElements.forEach(element => {
      const id = element.getAttribute(attribute);
      if (!id) return;

      const jobId = id.split(':').pop() ?? "";
      if (!jobId) return;

      const jobLink = element.querySelector('a');
      if (!jobLink) return;

      result.push({ 
        source_job_id: jobId, 
        link: jobLink?.href ?? "",
      });
    });

    return result;
  }, jobCardsSelector);

  return jobs;
}

export async function jobDetailsFromPage(
  job: Partial<JobInput>,
  page: Page
): Promise<JobInput | null> {
  await page.goto(job.link!, { waitUntil: 'networkidle2' });

  const titleSelector = 'top-card-layout__title';
  await page.waitForSelector(`.${titleSelector}`, { timeout: 10000 });
  const title = await page.$eval(
    `.${titleSelector}`,
    (el) => el.textContent?.trim() ?? ''
  );
  job.title = title;

  const companySelector = 'topcard__org-name-link';
  await page.waitForSelector(`.${companySelector}`, { timeout: 10000 });
  const company = await page.$eval(`.${companySelector}`, el => el.textContent?.trim() ?? '');
  job.company = company;

  const locationSelector = 'topcard__flavor--bullet';
  await page.waitForSelector(`.${locationSelector}`, { timeout: 10000 });
  const location = await page.$eval(`.${locationSelector}`, el => el.textContent?.trim() ?? '');
  job.location = location;

  const datePostedSelector = 'posted-time-ago__text';
  await page.waitForSelector(`.${datePostedSelector}`, { timeout: 10000 });
  const datePosted = await page.$eval(`.${datePostedSelector}`, el => el.textContent?.trim() ?? '');
  job.datePosted = datePosted;

  const descriptionSelector = '.show-more-less-html__markup';
  await page.waitForSelector(descriptionSelector, { timeout: 10000 });
  const description = await page.$eval(descriptionSelector, el => el.textContent?.trim() ?? '');
  job.description = description;

  return job as JobInput;
}

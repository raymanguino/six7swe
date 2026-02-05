import { Browser, Page } from "puppeteer";

export async function newPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  if (!page) {
    throw new Error('Failed to create new page');
  }
  await page.setViewport({ width: 1080, height: 1024 });
  return page;
}

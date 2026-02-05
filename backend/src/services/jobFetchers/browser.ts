import puppeteer, { Browser } from "puppeteer";

export async function newBrowser(): Promise<(Browser)> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--incognito', '--no-sandbox', '--disable-setuid-sandbox']
  });
  if (!browser) {
    throw new Error('Failed to launch browser');
  }
  return browser;
}

// Puppeteer reads this file from the working directory, which is `backend/` for both the
// build and the start command on Railway, and for `pnpm --filter` scripts locally.
//
// Chrome is kept inside the app directory, not in `~/.cache/puppeteer`, so the browser
// downloaded during the build ships in the deployed image and the runtime looks for it
// at the same path. See DEPLOYMENT.md, "Chrome for the job scraper".
const { join } = require('node:path');

/** @type {import('puppeteer').Configuration} */
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};

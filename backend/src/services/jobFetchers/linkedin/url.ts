const LINKEDIN_BASE_URL = 'https://www.linkedin.com';
/** LinkedIn job search URL 
 * Example URL: https://www.linkedin.com/jobs/search/?f_E=4&f_TPR=r86400&f_WT=2%2C1%2C3&geoId=105149290&keywords=Software%2BEngineer&refresh=true&sortBy=DD&position=1&pageNum=0
 * - f_E=4: Experience level (4 = Mid-Senior level)
 * - f_TPR=r86400: Time posted (r86400 = past 24 hours)
 * - f_WT=2%2C1%2C3: Work type (2 = Full-time, 1 = Internship, 3 = Contract)
 * - geoId=105149290: Location (105149290 = Ontario, Canada)
 * - keywords=Software%2BEngineer: Job title keywords
 * - sortBy=DD: Sort by date posted (DD = Date Descending)
 * - position=1&pageNum=0: Pagination (position and pageNum)
*/
export function buildLinkedInJobListUrl(
  keywords: Array<string> = [],
  location: string = '105149290', // Location (105149290 = Ontario, Canada)
  pageNum: number = 0,
): string {
  const baseUrl = `${LINKEDIN_BASE_URL}/jobs/search/`;
  const params = new URLSearchParams({
    f_E: '4', // Experience level (4 = Mid-Senior level)
    f_TPR: 'r86400', // Time posted (r86400 = past 24 hours)
    f_WT: '2,1,3', // Work type (2 = Full-time, 1 = Internship, 3 = Contract)
    geoId: location,
    keywords: keywords.map(keyword => `"${keyword}"`).join(','), // Enclose keywords with "" and join them with "," e.g., ["Software Engineer", "Developer"] => "%22Software+Engineer%22,%22Developer%22"
    sortBy: 'DD', // Sort by date posted (DD = Date Descending)
    position: '1',
    pageNum: pageNum.toString(),
    refresh: 'true',
  });

  return `${baseUrl}?${params.toString()}`;
}

export function sanitizeJobLink(link: string): string {
  const parts = /-(\d{10})\?/.exec(link)
  if (parts && parts.length > 0) {
    return `${LINKEDIN_BASE_URL}/jobs/view/${parts ? parts[1] : ''}/`;
  } else {
    // unable to find the job id so just trim the querystring params to keep the size of the link in check
    return link.split('?')[0];
  }
}

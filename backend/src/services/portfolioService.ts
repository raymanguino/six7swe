import { db } from '../db';
import { portfolioProfile, contentSections } from '../db/schema/portfolio';
import { eq, asc } from 'drizzle-orm';
import type { PortfolioData, PortfolioProfileData, ContentSectionData } from '../types/portfolio';
import { getPortfolioDataSource, isMcpConnectionConfigured } from '../config/portfolioMcp';
import { fetchPortfolioFromMcp } from './mcpPortfolioClient';
import { getDefaultProfileClient } from './knowledge/profileClient';
import { mapPublishedProfile } from './knowledge/profileMapping';
import { createSwrCache } from './staleWhileRevalidate';

export type { PortfolioProfileData, ContentSectionData, PortfolioData } from '../types/portfolio';

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_TTL_MS = Number(process.env.PORTFOLIO_CACHE_TTL_MS) || DEFAULT_CACHE_TTL_MS;
/** After a failed refresh, how long the last good data is served before trying again. */
const RETRY_AFTER_FAILURE_MS = 30_000;

async function fetchFromDb(): Promise<PortfolioData> {
  const [profileRow] = await db
    .select()
    .from(portfolioProfile)
    .where(eq(portfolioProfile.id, 1))
    .limit(1);

  const sections = await db
    .select()
    .from(contentSections)
    .orderBy(asc(contentSections.sortOrder), asc(contentSections.filename));

  const profile: PortfolioProfileData | null = profileRow
    ? {
        id: profileRow.id,
        name: profileRow.name,
        title: profileRow.title,
        email: profileRow.email,
        phone: profileRow.phone,
        location: profileRow.location,
        linkedinUrl: profileRow.linkedinUrl,
        githubUrl: profileRow.githubUrl,
        summary: profileRow.summary,
        skills: (profileRow.skills as string[]) ?? [],
        experience:
          (profileRow.experience as Array<{
            title: string;
            company: string;
            period: string;
            description: string;
          }>) ?? [],
        projects:
          (profileRow.projects as Array<{
            name: string;
            description: string;
            technologies: string[];
          }>) ?? [],
        fullResumeText: profileRow.fullResumeText,
        resumeFilename: profileRow.resumeFilename,
      }
    : null;

  const contentSectionsData: ContentSectionData[] = sections.map((s) => ({
    id: s.id,
    filename: s.filename,
    content: s.content,
    sortOrder: s.sortOrder ?? 0,
  }));

  return { profile, contentSections: contentSectionsData };
}

/**
 * The profile the owner published in the knowledge service (#86). Until the
 * owner publishes one, the profile seeded in the portfolio tables is shown, so
 * switching the data source never blanks the landing page; #88 retires those
 * tables and this fallback with them.
 */
async function fetchFromKnowledge(): Promise<PortfolioData> {
  const client = getDefaultProfileClient();
  if (!client) {
    throw new Error(
      'PORTFOLIO_DATA_SOURCE=knowledge requires KNOWLEDGE_URL and KNOWLEDGE_SERVICE_KEY',
    );
  }
  const published = mapPublishedProfile(await client.getPublished());
  if (published.profile) return published;
  const seeded = await fetchFromDb();
  return { ...seeded, knowledgeResume: published.knowledgeResume };
}

async function fetchPortfolioData(): Promise<PortfolioData> {
  const source = getPortfolioDataSource();
  if (source === 'mcp') {
    if (!isMcpConnectionConfigured()) {
      throw new Error(
        'PORTFOLIO_DATA_SOURCE=mcp requires MCP_PORTFOLIO_URL (streamable HTTP) or MCP_PORTFOLIO_COMMAND (stdio)',
      );
    }
    return fetchPortfolioFromMcp();
  }
  if (source === 'knowledge') return fetchFromKnowledge();
  return fetchFromDb();
}

/**
 * Stale-while-revalidate: once loaded, the portfolio is always answered from
 * memory, and refreshed in the background after the TTL. If the source is
 * down (the knowledge service, the database), the last good profile keeps
 * being served.
 */
const cache = createSwrCache(fetchPortfolioData, {
  ttlMs: CACHE_TTL_MS,
  retryAfterFailureMs: RETRY_AFTER_FAILURE_MS,
  onBackgroundError: (error) => {
    console.warn(
      'Portfolio refresh failed; serving the last good profile:',
      error instanceof Error ? error.message : error,
    );
  },
});

export async function getPortfolioData(): Promise<PortfolioData> {
  try {
    return await cache.get();
  } catch (error) {
    if (getPortfolioDataSource() !== 'knowledge') throw error;
    // The knowledge service is down and no profile has been loaded since the
    // start, so there is no last good one. Until #88 retires the portfolio
    // tables, the profile seeded there keeps the site up; it is not cached, so
    // the published profile returns as soon as the service does.
    console.warn(
      'Knowledge service unavailable and no profile cached; serving the seeded profile:',
      error instanceof Error ? error.message : error,
    );
    return fetchFromDb();
  }
}

/**
 * Busts the cache: the next request waits for fresh data (falling back to the
 * last good profile if the source is down). Called after the owner publishes
 * a profile.
 */
export function clearPortfolioCache(): void {
  cache.invalidate();
}

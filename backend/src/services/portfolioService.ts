import { db } from '../db';
import { portfolioProfile, contentSections } from '../db/schema';
import { eq, asc } from 'drizzle-orm';
import type { PortfolioData, PortfolioProfileData, ContentSectionData } from '../types/portfolio';
import { getPortfolioDataSource, isMcpConnectionConfigured } from '../config/portfolioMcp';
import { fetchPortfolioFromMcp } from './mcpPortfolioClient';

export type { PortfolioProfileData, ContentSectionData, PortfolioData } from '../types/portfolio';

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_TTL_MS = Number(process.env.PORTFOLIO_CACHE_TTL_MS) || DEFAULT_CACHE_TTL_MS;

let cache: { data: PortfolioData; expiresAt: number } | null = null;

function isCacheValid(): boolean {
  return cache !== null && Date.now() < cache.expiresAt;
}

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
          (profileRow.experience as Array<{ title: string; company: string; period: string; description: string }>) ??
          [],
        projects:
          (profileRow.projects as Array<{ name: string; description: string; technologies: string[] }>) ?? [],
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

async function fetchPortfolioData(): Promise<PortfolioData> {
  if (getPortfolioDataSource() === 'mcp') {
    if (!isMcpConnectionConfigured()) {
      throw new Error(
        'PORTFOLIO_DATA_SOURCE=mcp requires MCP_PORTFOLIO_URL (streamable HTTP) or MCP_PORTFOLIO_COMMAND (stdio)',
      );
    }
    return fetchPortfolioFromMcp();
  }
  return fetchFromDb();
}

export async function getPortfolioData(): Promise<PortfolioData> {
  if (isCacheValid() && cache) {
    return cache.data;
  }
  const data = await fetchPortfolioData();
  cache = {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  return data;
}

export function clearPortfolioCache(): void {
  cache = null;
}

import { db } from '../db';
import { portfolioProfile, contentSections } from '../db/schema';
import { eq, asc } from 'drizzle-orm';

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_TTL_MS = Number(process.env.PORTFOLIO_CACHE_TTL_MS) || DEFAULT_CACHE_TTL_MS;

export type PortfolioProfileData = {
  id: number;
  name: string;
  title: string;
  email: string;
  phone: string | null;
  location: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  summary: string | null;
  skills: string[];
  experience: Array<{ title: string; company: string; period: string; description: string }>;
  projects: Array<{ name: string; description: string; technologies: string[] }>;
  fullResumeText: string;
  resumeFilename: string | null;
};

export type ContentSectionData = {
  id: number;
  filename: string;
  content: string;
  sortOrder: number;
};

export type PortfolioData = {
  profile: PortfolioProfileData | null;
  contentSections: ContentSectionData[];
};

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
        experience: (profileRow.experience as Array<{ title: string; company: string; period: string; description: string }>) ?? [],
        projects: (profileRow.projects as Array<{ name: string; description: string; technologies: string[] }>) ?? [],
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

export async function getPortfolioData(): Promise<PortfolioData> {
  if (isCacheValid() && cache) {
    return cache.data;
  }
  const data = await fetchFromDb();
  cache = {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  return data;
}

export function clearPortfolioCache(): void {
  cache = null;
}

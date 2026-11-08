/**
 * Seeds the portfolio profile and the content sections.
 *
 * The profile data lives in scripts/portfolio-data.json, which is gitignored
 * because it is personal information. This script (the logic) is tracked, so
 * only the data needs to stay private.
 *
 * The content sections come from backend/content/, which is also gitignored
 * for the same reason.
 *
 * Idempotent: running it again replaces the rows rather than duplicating them.
 *
 * Usage:
 *   pnpm run db:seed-portfolio
 */

import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { resolveDatabaseTarget } from './db-env';

export interface PortfolioProfileData {
  name: string;
  title: string;
  email: string;
  phone: string | null;
  location: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  summary: string | null;
  skills: string[];
  experience: Array<{
    title: string;
    company: string;
    period: string;
    description: string;
  }>;
  projects: Array<{ name: string; description: string; technologies: string[] }>;
  fullResumeText: string;
  resumeFilename: string | null;
}

export interface ContentSection {
  filename: string;
  content: string;
  sortOrder: number;
}

const DATA_FILE = path.join(__dirname, 'portfolio-data.json');

/**
 * Reads the private profile data.
 *
 * Throws with a clear message when the file is missing, because the usual
 * cause is that the repository was cloned without the ignored files.
 */
export function loadPortfolioProfile(): PortfolioProfileData {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(
      `Missing ${path.relative(process.cwd(), DATA_FILE)}. ` +
        'Copy scripts/portfolio-data.example.json to scripts/portfolio-data.json ' +
        'and fill in your details.',
    );
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The portfolio data file does not contain a JSON object.');
  }

  const data = parsed as Partial<PortfolioProfileData>;

  if (!data.name || !data.title || !data.email || !data.fullResumeText) {
    throw new Error(
      'The portfolio data file is missing required fields: name, title, email and fullResumeText.',
    );
  }

  return {
    name: data.name,
    title: data.title,
    email: data.email,
    phone: data.phone ?? null,
    location: data.location ?? null,
    linkedinUrl: data.linkedinUrl ?? null,
    githubUrl: data.githubUrl ?? null,
    summary: data.summary ?? null,
    skills: data.skills ?? [],
    experience: data.experience ?? [],
    projects: data.projects ?? [],
    fullResumeText: data.fullResumeText,
    resumeFilename: data.resumeFilename ?? null,
  };
}

/**
 * Loads the content sections from backend/content/.
 *
 * Returns an empty list when the directory is missing, so the profile can be
 * seeded without the extra content.
 */
export function loadContentSections(): ContentSection[] {
  const contentDir = path.join(__dirname, '..', 'content');

  if (!fs.existsSync(contentDir) || !fs.statSync(contentDir).isDirectory()) {
    return [];
  }

  const extensions = ['.md', '.txt'];
  const matched = fs
    .readdirSync(contentDir)
    .filter((file) => extensions.some((ext) => file.endsWith(ext)))
    .sort();

  const sections: ContentSection[] = [];

  for (const [index, file] of matched.entries()) {
    const filePath = path.join(contentDir, file);
    if (!fs.statSync(filePath).isFile()) continue;
    sections.push({
      filename: path.basename(file, path.extname(file)),
      content: fs.readFileSync(filePath, 'utf-8'),
      sortOrder: index,
    });
  }

  return sections;
}

/**
 * Writes the profile and content sections to the database.
 *
 * The Drizzle client is imported lazily so the caller controls when it is
 * created: it binds to DATABASE_URL when first loaded, which has to happen
 * after the env file for the selected target is read.
 */
export async function seedPortfolioData(): Promise<{ sections: number }> {
  const { db } = await import('../src/db');
  const { contentSections, portfolioProfile } = await import('../src/db/schema');

  const profile = loadPortfolioProfile();

  const [existing] = await db
    .select()
    .from(portfolioProfile)
    .where(eq(portfolioProfile.id, 1))
    .limit(1);

  if (existing) {
    await db
      .update(portfolioProfile)
      .set({ ...profile, updatedAt: new Date() })
      .where(eq(portfolioProfile.id, 1));
  } else {
    await db.insert(portfolioProfile).values({ id: 1, ...profile });
  }

  const sections = loadContentSections();

  if (sections.length > 0) {
    await db.delete(contentSections);
    for (const section of sections) {
      await db.insert(contentSections).values({
        filename: section.filename,
        content: section.content,
        sortOrder: section.sortOrder,
      });
    }
  }

  return { sections: sections.length };
}

// Run directly: `pnpm run db:seed-portfolio`
if (require.main === module) {
  try {
    resolveDatabaseTarget();
  } catch (error) {
    process.stderr.write(
      `Portfolio seed failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }

  seedPortfolioData()
    .then((result) => {
      process.stdout.write(
        `Seeded the portfolio profile and ${result.sections} content section(s).\n`,
      );
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `Portfolio seed failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}

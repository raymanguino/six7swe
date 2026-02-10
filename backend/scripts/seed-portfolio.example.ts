/**
 * Example seed script for portfolio_profile and content_sections.
 *
 * Setup:
 * 1. Copy this file to seed-portfolio.ts: cp seed-portfolio.example.ts seed-portfolio.ts
 * 2. Replace placeholder values in PROFILE with your own data
 * 3. Run: pnpm run db:seed-portfolio
 *
 * Requires: DATABASE_URL.
 * If backend/content/ exists with .md/.txt files, they will be loaded into content_sections.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { db } from '../src/db';
import { portfolioProfile, contentSections } from '../src/db/schema';
import { eq } from 'drizzle-orm';

const PROFILE = {
  name: 'Your Name',
  title: 'Your Title (e.g. Software Engineer)',
  email: 'you@example.com',
  phone: null as string | null,
  location: null as string | null,
  linkedinUrl: null as string | null,
  githubUrl: null as string | null,
  summary: 'Your professional summary...',
  skills: [] as string[],
  experience: [] as Array<{ title: string; company: string; period: string; description: string }>,
  projects: [] as Array<{ name: string; description: string; technologies: string[] }>,
  fullResumeText: `
Your Name - Your Title

SUMMARY
Your professional summary for AI context...

SKILLS
- Skill 1
- Skill 2

EXPERIENCE
Company - Role
- Bullet points...

PROJECTS
Project name - Description
  `.trim(),
  resumeFilename: 'resume.pdf',
};

async function loadContentSections(): Promise<Array<{ filename: string; content: string; sortOrder: number }>> {
  const contentDir = path.join(__dirname, '..', 'content');
  if (!fs.existsSync(contentDir) || !fs.statSync(contentDir).isDirectory()) {
    return [];
  }
  const files = fs.readdirSync(contentDir);
  const ext = ['.md', '.txt'];
  const matched = files.filter((f) => ext.some((e) => f.endsWith(e))).sort();
  const sections: Array<{ filename: string; content: string; sortOrder: number }> = [];
  for (let i = 0; i < matched.length; i++) {
    const filePath = path.join(contentDir, matched[i]);
    if (!fs.statSync(filePath).isFile()) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    const filename = path.basename(matched[i], path.extname(matched[i]));
    sections.push({ filename, content, sortOrder: i });
  }
  return sections;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  // Upsert portfolio profile (id=1)
  const existing = await db.select().from(portfolioProfile).where(eq(portfolioProfile.id, 1)).limit(1);
  if (existing.length > 0) {
    await db
      .update(portfolioProfile)
      .set({
        ...PROFILE,
        updatedAt: new Date(),
      })
      .where(eq(portfolioProfile.id, 1));
    console.log('Updated portfolio_profile id=1');
  } else {
    await db.insert(portfolioProfile).values({
      id: 1,
      ...PROFILE,
    });
    console.log('Inserted portfolio_profile id=1');
  }

  const sections = await loadContentSections();
  if (sections.length > 0) {
    const existingSections = await db.select().from(contentSections);
    if (existingSections.length > 0) {
      await db.delete(contentSections);
    }
    for (const s of sections) {
      await db.insert(contentSections).values({
        filename: s.filename,
        content: s.content,
        sortOrder: s.sortOrder,
      });
    }
    console.log(`Seeded ${sections.length} content_sections`);
  } else {
    console.log('No content files found in backend/content/ - skipping content_sections');
  }

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

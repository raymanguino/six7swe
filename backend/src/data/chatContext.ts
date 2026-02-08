import fs from 'fs';
import path from 'path';
import { resumeData } from './resume';

const CONTENT_DIR = path.join(__dirname, '..', '..', 'content');
const EXTENSIONS = ['.md', '.txt'];

let cachedAdditionalContext: string | null = null;

function loadAdditionalContent(): string {
  if (cachedAdditionalContext !== null) {
    return cachedAdditionalContext;
  }
  const sections: string[] = [];
  try {
    if (!fs.existsSync(CONTENT_DIR) || !fs.statSync(CONTENT_DIR).isDirectory()) {
      cachedAdditionalContext = '';
      return '';
    }
    const files = fs.readdirSync(CONTENT_DIR);
    const contentFiles = files
      .filter((f) => EXTENSIONS.some((ext) => f.endsWith(ext)))
      .sort();
    for (const file of contentFiles) {
      const filePath = path.join(CONTENT_DIR, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(filePath, 'utf-8');
      const sectionLabel = path.basename(file, path.extname(file));
      const title = sectionLabel.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      sections.push(`## ${title}\n\n${content.trim()}`);
    }
    cachedAdditionalContext = sections.join('\n\n');
  } catch {
    cachedAdditionalContext = '';
  }
  return cachedAdditionalContext;
}

export function getChatContext(): string {
  const resumeSection = `Resume Information:\n${resumeData.fullResumeText}`;
  const additional = loadAdditionalContent();
  if (!additional.trim()) {
    return resumeSection;
  }
  return [resumeSection, '', 'Additional context:', '', additional].join('\n');
}

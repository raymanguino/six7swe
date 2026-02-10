import { getPortfolioData } from '../services/portfolioService';

export async function getChatContext(): Promise<string> {
  const { profile, contentSections } = await getPortfolioData();

  const resumeSection = profile
    ? `Resume Information:\n${profile.fullResumeText}`
    : 'Resume Information:\n(No profile data available.)';

  if (contentSections.length === 0) {
    return resumeSection;
  }

  const additional = contentSections
    .map((s) => {
      const title = s.filename.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      return `## ${title}\n\n${s.content.trim()}`;
    })
    .join('\n\n');

  return [resumeSection, '', 'Additional context:', '', additional].join('\n');
}

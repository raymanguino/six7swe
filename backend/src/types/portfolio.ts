import type { ProfileExperience, ProfileProject } from '@six7swe/knowledge-types';

export type PortfolioProfileData = {
  name: string;
  title: string;
  email: string;
  phone: string | null;
  location: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  summary: string | null;
  skills: string[];
  experience: ProfileExperience[];
  projects: ProfileProject[];
  fullResumeText: string;
  resumeFilename: string | null;
};

export type PortfolioData = {
  profile: PortfolioProfileData | null;
  /** The knowledge service's primary resume; null when it has none. `/resume` serves it when `isPdf`. */
  knowledgeResume: { filename: string; isPdf: boolean } | null;
};

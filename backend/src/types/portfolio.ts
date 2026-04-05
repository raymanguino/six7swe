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

import type { PublishedProfileResponse } from '@six7swe/knowledge-types';
import type { PortfolioData, PortfolioProfileData } from '../../types/portfolio';

/**
 * Maps the knowledge service's published profile (#86) to the backend's
 * `PortfolioData`, the shape `/portfolio`, chat, fitcheck and the contact
 * form already read, so none of them (nor `Landing.tsx`) changes.
 *
 * - `fullResumeText` is the primary resume's extracted text (fitcheck and the
 *   stuffed chat context read it); empty when there is none.
 * - `email` is `''` when the profile has none, which the contact form treats
 *   as "no recipient configured".
 * - The profile's `website` link has no field here and is not shown.
 *
 * `profile` is null when nothing is published yet.
 */
export function mapPublishedProfile(response: PublishedProfileResponse): PortfolioData {
  const { resume } = response;
  const knowledgeResume = resume ? { filename: resume.filename, isPdf: resume.isPdf } : null;
  if (!response.profile) return { profile: null, knowledgeResume };

  const { data } = response.profile;
  const profile: PortfolioProfileData = {
    // The portfolio has a single profile; the id only mirrors the old table's row.
    id: 1,
    name: data.name,
    title: data.title,
    email: data.links.email ?? '',
    phone: data.links.phone,
    location: data.location,
    linkedinUrl: data.links.linkedin,
    githubUrl: data.links.github,
    summary: data.summary || null,
    skills: data.skills,
    experience: data.experience,
    projects: data.projects,
    fullResumeText: resume?.text ?? '',
    resumeFilename: resume?.isPdf ? resume.filename : null,
  };
  return { profile, knowledgeResume };
}

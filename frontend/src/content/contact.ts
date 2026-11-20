/**
 * Contact details for the landing page. A null field hides its row.
 */
export type Contact = {
  email: string | null;
  phone: string | null;
  location: string | null;
  githubUrl: string | null;
  linkedinUrl: string | null;
};

export const CONTACT: Contact = {
  email: 'ray.manguino@gmail.com',
  phone: null,
  location: 'Greater Toronto Area, ON, Canada',
  githubUrl: 'https://github.com/raymanguino',
  linkedinUrl: 'https://linkedin.com/in/raymanguino',
};

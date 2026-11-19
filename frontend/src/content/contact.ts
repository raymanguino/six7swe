/**
 * Contact details for the landing page. A null field hides its row.
 *
 * PLACEHOLDER: fill in the real values by hand; nothing is shown until you do.
 */
export type Contact = {
  email: string | null;
  phone: string | null;
  location: string | null;
  githubUrl: string | null;
  linkedinUrl: string | null;
};

export const CONTACT: Contact = {
  email: null,
  phone: null,
  location: null,
  githubUrl: null,
  linkedinUrl: null,
};

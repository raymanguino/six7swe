/**
 * Contact details shown in the landing page's contact section.
 *
 * PLACEHOLDER: replace these values with the real ones. They used to come from the private
 * portfolio data, which is deliberately not copied into the repo; the owner fills this in by
 * hand. A null field hides its row.
 */
export type Profile = {
  email: string | null;
  phone: string | null;
  location: string | null;
  githubUrl: string | null;
  linkedinUrl: string | null;
};

export const profile: Profile = {
  email: 'you@example.com',
  phone: null,
  location: null,
  githubUrl: null,
  linkedinUrl: null,
};

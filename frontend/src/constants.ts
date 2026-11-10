// Input validation limits for security and UX
export const INPUT_LIMITS = {
  name: 100,
  email: 254,
  company: 200,
  message: 5000,
  chatMessage: 2000,
  jobDescription: 50000,
} as const;

/**
 * Where the Supabase confirmation link sends the browser back to.
 *
 * Must be listed in the project's redirect URLs, otherwise Supabase falls
 * back to the site URL and the link appears to do nothing.
 */
export const AUTH_CONFIRMATION_REDIRECT_PATH = '/hunter/login';

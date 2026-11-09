/** User context for request handling (id and email only). id can be string for UnauthenticatedUser placeholder. */
export type ContextUser = {
  id: number | string;
  /** Null when the authenticated identity carries no email claim. */
  email: string | null;
  /** External auth provider id (Supabase auth user id), when authenticated. */
  authId?: string;
};

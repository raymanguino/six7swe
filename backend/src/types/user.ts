/** User context for request handling (id and email only). id can be string for UnauthenticatedUser placeholder. */
export type ContextUser = {
  id: number | string;
  email: string;
  /** External auth provider id (Supabase auth user id), when authenticated. */
  authId?: string;
};

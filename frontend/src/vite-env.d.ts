/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the backend API. Falls back to the `/api` proxy prefix. */
  readonly VITE_API_URL?: string;
  /** Supabase project URL, used for job-hunter authentication. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon key, used for job-hunter authentication. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

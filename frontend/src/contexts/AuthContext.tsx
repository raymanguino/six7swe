import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import { setAccessTokenProvider } from '../utils/api';
import { describeAuthError, describeUrlAuthError } from '../utils/authErrors';
import { AUTH_CONFIRMATION_REDIRECT_PATH } from '../constants';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export interface SignUpResult {
  /**
   * True when the account still needs the emailed confirmation link before
   * it can sign in. False when the project auto-confirms addresses.
   */
  requiresEmailConfirmation: boolean;
}

export interface AuthContextValue {
  session: Session | null;
  userEmail: string | null;
  /** True while the session is still being restored on page load. */
  loading: boolean;
  /** True when no Supabase project is configured for this environment. */
  configured: boolean;
  /** Set when the browser arrived with a failed confirmation link. */
  linkError: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return null;
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return client;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkError, setLinkError] = useState<string | null>(null);

  const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

  useEffect(() => {
    // Supabase reports a failed confirmation link in the URL fragment. Read
    // it before the client clears the fragment while consuming the session.
    const fragmentError = describeUrlAuthError(window.location.hash);
    if (fragmentError) {
      setLinkError(fragmentError);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    const supabase = getClient();

    if (!supabase) {
      setLoading(false);
      return;
    }

    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      subscription.subscription.unsubscribe();
    };
  }, []);

  // Let the API client attach the current token to every request.
  useEffect(() => {
    const supabase = getClient();

    if (!supabase) {
      setAccessTokenProvider(null);
      return;
    }

    setAccessTokenProvider(async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    });

    return () => setAccessTokenProvider(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      userEmail: session?.user.email ?? null,
      loading,
      configured,
      linkError,
      signIn: async (email: string, password: string) => {
        const supabase = getClient();
        if (!supabase) throw new Error('Authentication is not configured.');
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw new Error(describeAuthError(error, 'Authentication failed.'));
      },
      signUp: async (email: string, password: string): Promise<SignUpResult> => {
        const supabase = getClient();
        if (!supabase) throw new Error('Authentication is not configured.');
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            // Where the confirmation link sends the browser back to. It must
            // be allow-listed in the Supabase project's redirect URLs.
            emailRedirectTo: `${window.location.origin}${AUTH_CONFIRMATION_REDIRECT_PATH}`,
          },
        });
        if (error) throw new Error(describeAuthError(error, 'Could not create the account.'));
        // A null session means the project still has to confirm the address.
        return { requiresEmailConfirmation: data.session === null };
      },
      signOut: async () => {
        const supabase = getClient();
        if (!supabase) return;
        await supabase.auth.signOut();
      },
    }),
    [session, loading, configured, linkError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }
  return context;
}

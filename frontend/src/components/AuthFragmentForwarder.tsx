import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AUTH_CONFIRMATION_REDIRECT_PATH } from '../constants';

/** A Supabase auth redirect carries a session or an error in the URL fragment. */
function hasAuthFragment(hash: string): boolean {
  return /[#&](access_token|error|error_code)=/.test(hash);
}

/**
 * Supabase falls back to the site URL when the confirmation redirect is not
 * allow-listed. The public shell has no auth provider, so hand such a fragment
 * to the hunter login route, which consumes it. Imports no auth code.
 */
export default function AuthFragmentForwarder() {
  const { hash } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (hasAuthFragment(hash)) {
      void navigate({ pathname: AUTH_CONFIRMATION_REDIRECT_PATH, hash }, { replace: true });
    }
  }, [hash, navigate]);

  return null;
}

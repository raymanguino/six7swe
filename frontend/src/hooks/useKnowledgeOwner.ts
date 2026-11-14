import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { ApiError, apiRequest } from '../utils/api';

/** Pause before the one retry after a failed check. */
const RETRY_DELAY_MS = 2000;

export interface KnowledgeOwnerState {
  /** True or false once the backend has answered; null while loading or unknown. */
  isOwner: boolean | null;
  /** The check failed twice for a reason other than 401/403, so the answer is unknown. */
  failed: boolean;
}

/**
 * Whether the signed-in user owns the knowledge base, as the backend decides
 * it (`sub === OWNER_AUTH_ID`).
 *
 * Only hides or shows the Knowledge nav entry and page: the backend refuses
 * every knowledge request from anyone else with 403 regardless. A 401 or 403
 * means "not the owner". Any other failure (a network blip, a 5xx) leaves the
 * answer unknown and is retried once, so it never hides the entry from the
 * owner or sends them away from the page.
 */
export function useKnowledgeOwner(): KnowledgeOwnerState {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [state, setState] = useState<KnowledgeOwnerState>({ isOwner: null, failed: false });

  useEffect(() => {
    if (!userId) {
      setState({ isOwner: false, failed: false });
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setState({ isOwner: null, failed: false });

    const check = (retriesLeft: number) => {
      apiRequest('/knowledge/access')
        .then((data: unknown) => {
          const owner =
            typeof data === 'object' && data !== null && 'isOwner' in data && data.isOwner === true;
          if (!cancelled) setState({ isOwner: owner, failed: false });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
            setState({ isOwner: false, failed: false });
          } else if (retriesLeft > 0) {
            retryTimer = setTimeout(() => check(retriesLeft - 1), RETRY_DELAY_MS);
          } else {
            setState({ isOwner: null, failed: true });
          }
        });
    };
    check(1);

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [userId]);

  return state;
}

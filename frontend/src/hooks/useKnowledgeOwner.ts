import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiRequest } from '../utils/api';

/**
 * Whether the signed-in user owns the knowledge base, as the backend decides
 * it (`sub === OWNER_AUTH_ID`). Null while the answer is loading.
 *
 * Only hides or shows the Knowledge nav entry and page: the backend refuses
 * every knowledge request from anyone else with 403 regardless.
 */
export function useKnowledgeOwner(): boolean | null {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [isOwner, setIsOwner] = useState<boolean | null>(null);

  useEffect(() => {
    if (!userId) {
      setIsOwner(false);
      return;
    }
    let cancelled = false;
    setIsOwner(null);
    apiRequest('/knowledge/access')
      .then((data: unknown) => {
        const owner =
          typeof data === 'object' && data !== null && 'isOwner' in data && data.isOwner === true;
        if (!cancelled) setIsOwner(owner);
      })
      .catch(() => {
        // Fail closed: an error hides the entry rather than showing a page
        // whose every request would fail.
        if (!cancelled) setIsOwner(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return isOwner;
}

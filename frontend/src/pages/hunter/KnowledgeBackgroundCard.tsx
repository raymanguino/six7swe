import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest } from '../../utils/api';
import type { KnowledgeStatus } from './types';

function describe(status: KnowledgeStatus): string {
  if (!status.configured) return 'not configured; matches are scored on this profile alone';
  if (status.documentCount === null) return 'connected';
  const docs = `${status.documentCount} ${status.documentCount === 1 ? 'doc' : 'docs'}`;
  if (!status.updatedAt) return docs;
  const updated = new Date(status.updatedAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return `${docs}, updated ${updated}`;
}

/**
 * Where a profile's matches get the candidate's background: the knowledge
 * base, not text pasted into the profile.
 */
export default function KnowledgeBackgroundCard() {
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/job-hunt/knowledge')
      .then((data) => {
        if (!cancelled) setStatus(data as KnowledgeStatus);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to read the knowledge base');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const detail = error ? 'unavailable' : status ? describe(status) : 'loading...';

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/60">
      <p className="text-sm font-medium text-gray-900 dark:text-white">
        Background: knowledge base ({detail})
      </p>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
        Each job is scored against the parts of your documents most relevant to it. Upload or
        replace documents on the{' '}
        <Link to="/hunter/knowledge" className="font-medium text-primary-600 hover:underline">
          Knowledge page
        </Link>
        ; matches scored before a change are flagged for rescoring.
      </p>
    </div>
  );
}

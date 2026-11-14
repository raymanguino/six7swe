import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../utils/api';
import type { MatchBand, MatchKnowledgeState, ProfileJob, RefreshStatusRow } from './types';

const RESCORE_POLL_MS = 3000;

interface MatchWithDetails extends ProfileJob {
  job: {
    id: number;
    sourceId: string | null;
    sourceJobId: string;
    link: string;
    company: string;
    position: string;
    description: string;
    location: string | null;
    datePosted: string | null;
  };
}

const BAND_STYLES: Record<MatchBand, string> = {
  TOP: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200',
  HIGH: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200',
  MEDIUM: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-200',
  LOW: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

/**
 * Starts a rescore of the stale matches and polls its refresh row until it
 * finishes, then calls `onDone` so the list reloads.
 */
function useRescore(profileId: number, onDone: () => Promise<void>) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    stop();
    setRunning(true);
    setError(null);
    try {
      const data = await apiRequest(`/job-hunt/profiles/${profileId}/jobs/rescore`, {
        method: 'POST',
      });
      const refreshId = data.refreshStatusId as number;

      const tick = async () => {
        try {
          const status = await apiRequest(
            `/job-hunt/profiles/${profileId}/jobs/refresh/${refreshId}`,
          );
          const row = status.refreshStatus as RefreshStatusRow;
          if (row.status === 'COMPLETED' || row.status === 'FAILED') {
            if (row.status === 'FAILED') setError(row.description ?? 'Rescore failed');
            setRunning(false);
            await onDone();
            return;
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to read rescore status');
          setRunning(false);
          return;
        }
        timerRef.current = window.setTimeout(() => void tick(), RESCORE_POLL_MS);
      };
      timerRef.current = window.setTimeout(() => void tick(), RESCORE_POLL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start rescore');
      setRunning(false);
    }
  }, [profileId, onDone, stop]);

  return { running, error, start };
}

/** Says how many matches predate the current knowledge base, with a Rescore action. */
function StaleBanner({
  staleCount,
  running,
  error,
  onRescore,
}: {
  staleCount: number;
  running: boolean;
  error: string | null;
  onRescore: () => void;
}) {
  if (staleCount === 0 && !error) return null;
  return (
    <div
      role="status"
      className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        {staleCount > 0 ? (
          <p>
            {staleCount === 1 ? '1 match was' : `${staleCount} matches were`} scored against an
            older version of your knowledge base.
          </p>
        ) : (
          <p>The rescore did not finish.</p>
        )}
        {staleCount > 0 && (
          <button
            type="button"
            onClick={onRescore}
            disabled={running}
            className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? 'Rescoring...' : 'Rescore'}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}

/** Shows the scored matches for a profile. */
export default function JobList({ profileId }: { profileId: number }) {
  const [matches, setMatches] = useState<MatchWithDetails[]>([]);
  const [knowledge, setKnowledge] = useState<MatchKnowledgeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMatches = useCallback(async () => {
    const data = await apiRequest(`/job-hunt/profiles/${profileId}/jobs`);
    setMatches((data.jobs ?? []) as MatchWithDetails[]);
    setKnowledge((data.knowledge ?? null) as MatchKnowledgeState | null);
  }, [profileId]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      await fetchMatches();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load matches');
    } finally {
      setLoading(false);
    }
  }, [fetchMatches]);

  // After a rescore the list refreshes in place, without the loading state.
  const reloadQuietly = useCallback(async () => {
    try {
      await fetchMatches();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load matches');
    }
  }, [fetchMatches]);

  const rescore = useRescore(profileId, reloadQuietly);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className="text-sm text-gray-500">Loading matches...</p>;
  }

  if (error) {
    return (
      <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
        {error}
      </p>
    );
  }

  if (matches.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-600">
        No scored jobs yet. Run a refresh to fetch and score postings.
      </p>
    );
  }

  return (
    <div>
      <StaleBanner
        staleCount={knowledge?.staleCount ?? 0}
        running={rescore.running}
        error={rescore.error}
        onRescore={() => void rescore.start()}
      />

      <ul className="space-y-3">
        {matches.map((match) => (
          <li
            key={match.id}
            className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <a
                  href={match.job.link}
                  target="_blank"
                  rel="noreferrer"
                  className="text-lg font-semibold text-gray-900 hover:text-primary-600 dark:text-white"
                >
                  {match.job.position}
                </a>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {match.job.company}
                  {match.job.location ? ` · ${match.job.location}` : ''}
                  {match.job.datePosted ? ` · ${match.job.datePosted}` : ''}
                </p>
              </div>

              <div className="flex items-center gap-2">
                {match.stale && (
                  <span
                    title="Scored against an older version of your knowledge base"
                    className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200"
                  >
                    Stale
                  </span>
                )}
                {match.score !== null && (
                  <span className="text-lg font-bold text-gray-900 dark:text-white">
                    {match.score}
                  </span>
                )}
                {match.band && (
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${BAND_STYLES[match.band]}`}
                  >
                    {match.band}
                  </span>
                )}
              </div>
            </div>

            {match.summary && (
              <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">{match.summary}</p>
            )}

            {match.explanation && (
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{match.explanation}</p>
            )}

            {(match.firstSkillMatch || match.secondSkillMatch || match.thirdSkillMatch) && (
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {[match.firstSkillMatch, match.secondSkillMatch, match.thirdSkillMatch]
                  .filter(Boolean)
                  .map((skill) => (
                    <span
                      key={skill as string}
                      className="rounded-full bg-gray-100 px-2 py-1 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                    >
                      {skill}
                    </span>
                  ))}
              </div>
            )}

            {match.evidence.length > 0 && (
              <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                <span className="font-medium">Evidence:</span>
                <ul className="mt-1 flex flex-wrap gap-2">
                  {match.evidence.map((doc) => (
                    <li
                      key={doc.documentId}
                      className="rounded border border-gray-200 px-2 py-0.5 dark:border-gray-600"
                    >
                      {doc.filename}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

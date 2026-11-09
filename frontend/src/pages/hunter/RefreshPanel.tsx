import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../utils/api';
import type { RefreshStatusRow } from './types';

const POLL_INTERVAL_MS = 3000;

/**
 * Starts a job refresh and shows its progress.
 *
 * The refresh runs on the server, so the panel polls the status endpoint
 * until the run reaches a terminal state.
 */
export default function RefreshPanel({ profileId }: { profileId: number }) {
  const [status, setStatus] = useState<RefreshStatusRow | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(
    (refreshId: number) => {
      const tick = async () => {
        try {
          const data = await apiRequest(
            `/job-hunt/profiles/${profileId}/jobs/refresh/${refreshId}`,
          );
          const next = data.refreshStatus as RefreshStatusRow;
          setStatus(next);

          if (next.status === 'COMPLETED' || next.status === 'FAILED') {
            stopPolling();
            return;
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to read refresh status');
          stopPolling();
          return;
        }

        timerRef.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
      };

      timerRef.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    },
    [profileId, stopPolling],
  );

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    stopPolling();

    try {
      const data = await apiRequest(`/job-hunt/profiles/${profileId}/jobs/refresh`, {
        method: 'POST',
      });
      setStatus({
        id: data.refreshStatusId,
        profileId,
        status: 'PENDING',
        step: 'PENDING',
        description: 'Refresh queued.',
        createdAt: null,
        updatedAt: null,
      });
      poll(data.refreshStatusId as number);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start refresh');
    } finally {
      setStarting(false);
    }
  };

  const isRunning = status?.status === 'PENDING' || status?.status === 'IN_PROGRESS';

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Job refresh</h3>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Scrapes new postings and scores them against this profile.
          </p>
        </div>
        <button
          type="button"
          onClick={handleStart}
          disabled={starting || isRunning}
          className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {starting ? 'Starting...' : isRunning ? 'Running...' : 'Start refresh'}
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
          {error}
        </p>
      )}

      {status && (
        <div className="mt-4 rounded-lg bg-gray-50 p-4 dark:bg-gray-700/50">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-gray-900 dark:text-white">Status:</span>
            <span
              className={
                status.status === 'COMPLETED'
                  ? 'text-green-600 dark:text-green-400'
                  : status.status === 'FAILED'
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-yellow-600 dark:text-yellow-400'
              }
            >
              {status.status}
            </span>
            <span className="text-gray-500 dark:text-gray-400">· step {status.step}</span>
          </div>
          {status.description && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{status.description}</p>
          )}
        </div>
      )}
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../../utils/api';
import type { MatchBand, ProfileJob } from './types';

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

/** Shows the scored matches for a profile. */
export default function JobList({ profileId }: { profileId: number }) {
  const [matches, setMatches] = useState<MatchWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiRequest(`/job-hunt/profiles/${profileId}/jobs`);
      setMatches((data.jobs ?? []) as MatchWithDetails[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load matches');
    } finally {
      setLoading(false);
    }
  }, [profileId]);

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
        </li>
      ))}
    </ul>
  );
}

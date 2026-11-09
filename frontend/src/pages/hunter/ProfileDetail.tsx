import { Link, useParams } from 'react-router-dom';
import RefreshPanel from './RefreshPanel';
import JobList from './JobList';
import { parseNumericParam } from './params';

/** A single profile: refresh controls plus the scored matches. */
export default function ProfileDetail() {
  const { profileId } = useParams<{ profileId: string }>();

  const numericId = parseNumericParam(profileId);

  if (numericId === null) {
    return (
      <div className="space-y-4">
        <Link
          to="/hunter/profiles"
          className="text-sm font-medium text-primary-600 hover:underline"
        >
          &larr; All profiles
        </Link>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          This profile link is not valid.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          to="/hunter/profiles"
          className="text-sm font-medium text-primary-600 hover:underline"
        >
          &larr; All profiles
        </Link>
        <h2 className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">
          Profile #{numericId}
        </h2>
      </div>

      <RefreshPanel profileId={numericId} />

      <section>
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
          Scored matches
        </h3>
        <JobList profileId={numericId} />
      </section>
    </div>
  );
}

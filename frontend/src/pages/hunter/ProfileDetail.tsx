import { Link, useParams } from 'react-router-dom';
import RefreshPanel from './RefreshPanel';
import JobList from './JobList';

/** A single profile: refresh controls plus the scored matches. */
export default function ProfileDetail() {
  const { profileId } = useParams<{ profileId: string }>();

  if (!profileId) {
    return <p className="text-sm text-gray-500">No profile selected.</p>;
  }

  const numericId = Number(profileId);

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

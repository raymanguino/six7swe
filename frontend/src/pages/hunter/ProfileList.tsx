import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest } from '../../utils/api';
import type { SearchProfile } from './types';

/** Lists the signed-in user's search profiles and allows creating one. */
export default function ProfileList() {
  const [profiles, setProfiles] = useState<SearchProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [keywords, setKeywords] = useState('');
  const [geoId, setGeoId] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiRequest('/job-hunt/profiles');
      setProfiles((data.profiles ?? []) as SearchProfile[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profiles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setError(null);

    try {
      await apiRequest('/job-hunt/profiles', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          keywords: keywords
            .split(',')
            .map((keyword) => keyword.trim())
            .filter(Boolean),
          location: geoId.trim() || null,
        }),
      });

      setName('');
      setKeywords('');
      setGeoId('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create profile');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (profile: SearchProfile) => {
    setError(null);
    try {
      await apiRequest(`/job-hunt/profiles/${profile.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete profile');
    }
  };

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Search profiles</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          Each profile defines what you are looking for: keywords, location and resume.
        </p>
      </section>

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
          {error}
        </p>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
          New profile
        </h3>
        <form onSubmit={handleCreate} className="grid gap-4 sm:grid-cols-3">
          <div>
            <label
              htmlFor="profile-name"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Name
            </label>
            <input
              id="profile-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Senior Backend"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
          </div>

          <div>
            <label
              htmlFor="profile-keywords"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Keywords (comma separated)
            </label>
            <input
              id="profile-keywords"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="Go, Kubernetes"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
          </div>

          <div>
            <label
              htmlFor="profile-geo"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              LinkedIn geo id
            </label>
            <input
              id="profile-geo"
              value={geoId}
              onChange={(e) => setGeoId(e.target.value)}
              placeholder="105149290"
              pattern="[0-9]*"
              title="Numeric region id, not a city name."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Numeric region id, not a city name.
            </p>
          </div>

          <div className="sm:col-span-3">
            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create profile'}
            </button>
          </div>
        </form>
      </section>

      <section>
        {loading ? (
          <p className="text-sm text-gray-500">Loading profiles...</p>
        ) : profiles.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-600">
            No profiles yet. Create one above to start a job search.
          </p>
        ) : (
          <ul className="space-y-3">
            {profiles.map((profile) => (
              <li
                key={profile.id}
                className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
              >
                <div>
                  <p className="font-semibold text-gray-900 dark:text-white">{profile.name}</p>
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    {(profile.keywords ?? []).join(', ') || 'No keywords'}
                    {profile.location ? ` · geo ${profile.location}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Link
                    to={`/hunter/profiles/${profile.id}`}
                    className="text-sm font-medium text-primary-600 hover:underline"
                  >
                    Open
                  </Link>
                  <button
                    type="button"
                    onClick={() => handleDelete(profile)}
                    className="text-sm font-medium text-red-600 hover:underline"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

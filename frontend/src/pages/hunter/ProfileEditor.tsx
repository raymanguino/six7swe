import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiRequest } from '../../utils/api';
import type { SearchProfile } from './types';
import { parseNumericParam } from './params';

/** Edits a single search profile. */
export default function ProfileEditor() {
  const { profileId } = useParams<{ profileId: string }>();
  const numericId = parseNumericParam(profileId);
  const [profile, setProfile] = useState<SearchProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [name, setName] = useState('');
  const [keywords, setKeywords] = useState('');
  const [geoId, setGeoId] = useState('');
  const [additionalContext, setAdditionalContext] = useState('');
  const [resume, setResume] = useState('');

  const load = useCallback(async () => {
    if (numericId === null) return;
    try {
      setLoading(true);
      setError(null);
      const data = await apiRequest(`/job-hunt/profiles/${numericId}`);
      const loaded = data.profile as SearchProfile;
      setProfile(loaded);
      setName(loaded.name);
      setKeywords((loaded.keywords ?? []).join(', '));
      setGeoId(loaded.location ?? '');
      setAdditionalContext(loaded.additionalContext ?? '');
      setResume(loaded.resume ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile');
    } finally {
      setLoading(false);
    }
  }, [numericId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const data = await apiRequest(`/job-hunt/profiles/${numericId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          keywords: keywords
            .split(',')
            .map((keyword) => keyword.trim())
            .filter(Boolean),
          location: geoId.trim() || null,
          additionalContext: additionalContext.trim() || null,
          resume: resume.trim() || null,
        }),
      });
      setProfile(data.profile as SearchProfile);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  if (numericId === null) {
    return (
      <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
        This profile link is not valid.
      </p>
    );
  }

  if (loading) {
    return <p className="text-sm text-gray-500">Loading profile...</p>;
  }

  if (!profile) {
    return (
      <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
        {error ?? 'Profile not found.'}
      </p>
    );
  }

  return (
    <form onSubmit={handleSave} className="max-w-2xl space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Edit profile</h2>

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
          {error}
        </p>
      )}
      {saved && (
        <p className="rounded-lg bg-green-50 p-3 text-sm text-green-700 dark:bg-green-900/40 dark:text-green-200">
          Saved.
        </p>
      )}

      <div>
        <label
          htmlFor="edit-name"
          className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Name
        </label>
        <input
          id="edit-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        />
      </div>

      <div>
        <label
          htmlFor="edit-keywords"
          className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Keywords (comma separated)
        </label>
        <input
          id="edit-keywords"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        />
      </div>

      <div>
        <label
          htmlFor="edit-geo"
          className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          LinkedIn geo id
        </label>
        <input
          id="edit-geo"
          value={geoId}
          onChange={(e) => setGeoId(e.target.value)}
          placeholder="105149290"
          pattern="[0-9]*"
          title="Numeric region id, not a city name."
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        />
      </div>

      <div>
        <label
          htmlFor="edit-context"
          className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Additional context
        </label>
        <textarea
          id="edit-context"
          value={additionalContext}
          onChange={(e) => setAdditionalContext(e.target.value)}
          rows={4}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        />
      </div>

      <div>
        <label
          htmlFor="edit-resume"
          className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Resume text
        </label>
        <textarea
          id="edit-resume"
          value={resume}
          onChange={(e) => setResume(e.target.value)}
          rows={8}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save changes'}
      </button>
    </form>
  );
}

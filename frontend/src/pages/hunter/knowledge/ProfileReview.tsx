import { useState } from 'react';
import ProfileDraftEditor from './ProfileDraftEditor';
import { diffProfiles, EMPTY_PROFILE, type ProfileData } from './profileTypes';
import type { KnowledgeProfile } from './useKnowledgeProfile';

const primaryButton =
  'rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton =
  'rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700';

const formatTime = (iso: string) => new Date(iso).toLocaleString();

/**
 * The landing-page profile (#86): when a resume becomes primary, a model
 * drafts the profile from it. The owner reviews the draft against what is
 * published, edits it, and publishes it. The landing page shows the
 * published profile once the backend's cache refreshes (publishing busts it).
 */
export default function ProfileReview({ profile }: { profile: KnowledgeProfile }) {
  const [editing, setEditing] = useState<ProfileData | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const { state, loading, error, busy } = profile;

  if (loading && !state) {
    return <p className="text-sm text-gray-500">Loading profile...</p>;
  }

  const drafting = state?.drafting;
  const draft = state?.draft ?? null;
  const published = state?.published ?? null;
  const rows = draft ? diffProfiles(published?.data ?? null, draft.data) : [];
  const changed = rows.filter((row) => row.changed);
  const visibleRows = showUnchanged ? rows : changed;

  return (
    <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Landing profile</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            Drafted from the primary resume whenever a new one is ready. Review the changes, edit
            them, then publish; the landing page shows only the published profile.
          </p>
        </div>
        {drafting?.enabled && (
          <button
            type="button"
            disabled={busy || drafting.state === 'drafting'}
            onClick={() => void profile.redraft()}
            className={secondaryButton}
          >
            Redraft from resume
          </button>
        )}
      </div>

      {drafting && !drafting.enabled && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Drafting is off on the knowledge service (set PROFILE_DRAFTER). You can still write the
          profile by hand.
        </p>
      )}
      {drafting?.state === 'drafting' && (
        <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
          Drafting a profile from the primary resume...
        </p>
      )}
      {drafting?.state === 'failed' && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
          The last draft failed: {drafting.error ?? 'unknown error'}
        </p>
      )}
      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
          {error}
        </p>
      )}

      {editing ? (
        <ProfileDraftEditor
          initial={editing}
          saving={busy}
          onSave={profile.saveDraft}
          onCancel={() => setEditing(null)}
        />
      ) : draft ? (
        <div className="space-y-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Draft updated {formatTime(draft.updatedAt)}
            {published
              ? ` · published ${formatTime(published.updatedAt)}`
              : ' · nothing published yet'}
            {' · '}
            {changed.length} change{changed.length === 1 ? '' : 's'}
          </p>

          {visibleRows.length === 0 ? (
            <p className="text-sm text-gray-500">The draft matches the published profile.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs uppercase text-gray-500 dark:border-gray-700">
                    <th className="w-36 py-2 pr-3">Field</th>
                    <th className="py-2 pr-3">Published</th>
                    <th className="py-2">Draft</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr
                      key={row.label}
                      className="border-b border-gray-100 align-top dark:border-gray-700/60"
                    >
                      <td className="py-2 pr-3 font-medium text-gray-700 dark:text-gray-300">
                        {row.label}
                      </td>
                      <td
                        className={`whitespace-pre-wrap py-2 pr-3 ${
                          row.changed
                            ? 'bg-red-50 text-red-800 line-through decoration-red-300 dark:bg-red-900/20 dark:text-red-200'
                            : 'text-gray-600 dark:text-gray-300'
                        }`}
                      >
                        {row.published || <span className="italic text-gray-400">empty</span>}
                      </td>
                      <td
                        className={`whitespace-pre-wrap py-2 ${
                          row.changed
                            ? 'bg-green-50 text-green-900 dark:bg-green-900/20 dark:text-green-200'
                            : 'text-gray-600 dark:text-gray-300'
                        }`}
                      >
                        {row.draft || <span className="italic text-gray-400">empty</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              checked={showUnchanged}
              onChange={(e) => setShowUnchanged(e.target.checked)}
            />
            Show unchanged fields
          </label>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy || drafting?.state === 'drafting'}
              onClick={() => void profile.publish()}
              className={primaryButton}
            >
              Publish
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(draft.data)}
              className={secondaryButton}
            >
              Edit draft
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm('Discard the draft? The published profile stays as it is.')) {
                  void profile.discardDraft();
                }
              }}
              className={secondaryButton}
            >
              Discard draft
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {published
              ? `No unpublished changes. Published ${formatTime(published.updatedAt)}: ${published.data.name}, ${published.data.title}.`
              : 'No profile yet. Upload a resume to draft one, or write it yourself.'}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(published?.data ?? EMPTY_PROFILE)}
            className={secondaryButton}
          >
            {published ? 'Edit published profile' : 'Write a profile'}
          </button>
        </div>
      )}
    </section>
  );
}

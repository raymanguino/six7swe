import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest } from '../../../utils/api';
import { errorMessage } from '../../../utils/errorMessage';
import {
  expectedVersionOf,
  parseProfileResponse,
  parseProfileState,
  parseSaveDraftConflict,
  type Profile,
  type ProfileData,
  type ProfileState,
} from './profileTypes';

/** How often the profile is re-read while a draft is being written. */
const POLL_INTERVAL_MS = 3000;
/** Drafting calls a model; give up following it after this long. */
const POLL_LIMIT_MS = 5 * 60 * 1000;
const DRAFTING_TIMEOUT_MESSAGE = 'Drafting is taking longer than expected. Reload to check.';

/**
 * How a draft save ended. `conflict` carries the draft the service holds now
 * (null: there is none), which a save over it must expect. `failed` sets
 * `error`; `conflict` does not.
 */
export type SaveDraftResult =
  | { status: 'saved'; profile: Profile }
  | { status: 'conflict'; current: Profile | null }
  | { status: 'failed' };

/** An action's outcome: its value, or a failure already reported through `error`. */
type ActResult<T> = { ok: true; value: T } | { ok: false };

export interface KnowledgeProfile {
  state: ProfileState | null;
  loading: boolean;
  /** The last read or action failed, with why; cleared by the next success. */
  error: string | null;
  /** True while an action is in flight. */
  busy: boolean;
  reload: () => Promise<void>;
  /**
   * Saves the owner's edits over the draft they were made on:
   * `expectedVersion` is that draft's `version`, or null when there was no
   * draft (see `expectedVersionOf`). Resolves `conflict`, writing nothing,
   * when the draft has changed since. The state is re-read either way.
   */
  saveDraft: (data: ProfileData, expectedVersion: number | null) => Promise<SaveDraftResult>;
  /** Asks the service to draft again from the primary resume. */
  redraft: () => Promise<void>;
  discardDraft: () => Promise<void>;
  /** Publishes the draft as reviewed (by its `version`). */
  publish: () => Promise<void>;
}

/**
 * The owner's structured profile through the backend's `/knowledge/profile*`
 * proxy. While the service is drafting, the state is re-read until it
 * settles, for at most `POLL_LIMIT_MS`. `refreshKey` re-reads it from outside,
 * e.g. when a resume finishes ingesting and drafting may have started.
 */
export function useKnowledgeProfile(enabled: boolean, refreshKey: string | null): KnowledgeProfile {
  const [state, setState] = useState<ProfileState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null);
  const mounted = useRef(true);
  const loadSeq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const next = parseProfileState(await apiRequest('/knowledge/profile'));
      if (!mounted.current || seq !== loadSeq.current) return;
      setState(next);
      setError(null);
    } catch (err) {
      if (!mounted.current || seq !== loadSeq.current) return;
      setError(errorMessage(err, 'Failed to load the profile'));
    } finally {
      if (mounted.current && seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload, refreshKey]);

  const drafting = state?.drafting.state === 'drafting';
  useEffect(() => {
    setPollStartedAt(drafting ? Date.now() : null);
  }, [drafting]);

  useEffect(() => {
    if (!enabled || pollStartedAt === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - pollStartedAt > POLL_LIMIT_MS) {
        // Stop following it, but say so rather than show "drafting" forever.
        if (mounted.current) setError(DRAFTING_TIMEOUT_MESSAGE);
        return;
      }
      await reload();
      if (!cancelled) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, pollStartedAt, reload]);

  /** Runs an action, reports its failure, then re-reads the state. */
  const act = useCallback(
    async <T>(run: () => Promise<T>, fallback: string): Promise<ActResult<T>> => {
      setBusy(true);
      let result: ActResult<T>;
      let failure: string | null = null;
      try {
        result = { ok: true, value: await run() };
      } catch (err) {
        failure = errorMessage(err, fallback);
        result = { ok: false };
      }
      await reload();
      if (mounted.current) {
        setBusy(false);
        // A successful reload clears the error; the action's own failure stays.
        if (failure) setError(failure);
      }
      return result;
    },
    [reload],
  );

  const saveDraft = useCallback(
    async (data: ProfileData, expectedVersion: number | null): Promise<SaveDraftResult> => {
      const result = await act(async (): Promise<SaveDraftResult> => {
        try {
          const profile = parseProfileResponse(
            await apiRequest('/knowledge/profile/draft', {
              method: 'PUT',
              body: JSON.stringify({ data, expectedVersion }),
            }),
          );
          return { status: 'saved', profile };
        } catch (err) {
          // The draft changed since: the caller shows the owner the current one.
          if (err instanceof ApiError && err.status === 409) {
            return { status: 'conflict', current: parseSaveDraftConflict(err.body) };
          }
          throw err;
        }
      }, 'Could not save the draft');
      return result.ok ? result.value : { status: 'failed' };
    },
    [act],
  );

  const redraft = useCallback(async () => {
    await act(async () => {
      await apiRequest('/knowledge/profile/draft', { method: 'POST' });
    }, 'Could not start drafting');
  }, [act]);

  const discardDraft = useCallback(async () => {
    await act(async () => {
      await apiRequest('/knowledge/profile/draft', { method: 'DELETE' });
    }, 'Could not discard the draft');
  }, [act]);

  // Null only when there is no draft to publish.
  const draftVersion = expectedVersionOf(state?.draft ?? null);
  const publish = useCallback(async () => {
    if (draftVersion === null) return;
    await act(async () => {
      parseProfileResponse(
        await apiRequest('/knowledge/profile/publish', {
          method: 'POST',
          body: JSON.stringify({ draftVersion }),
        }),
      );
    }, 'Could not publish the profile');
  }, [act, draftVersion]);

  return { state, loading, error, busy, reload, saveDraft, redraft, discardDraft, publish };
}

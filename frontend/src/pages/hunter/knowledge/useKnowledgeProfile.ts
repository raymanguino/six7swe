import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest } from '../../../utils/api';
import { errorMessage } from '../../../utils/errorMessage';
import {
  parseProfileResponse,
  parseProfileState,
  type ProfileData,
  type ProfileState,
} from './profileTypes';

/** How often the profile is re-read while a draft is being written. */
const POLL_INTERVAL_MS = 3000;
/** Drafting calls a model; give up following it after this long. */
const POLL_LIMIT_MS = 5 * 60 * 1000;
const DRAFTING_TIMEOUT_MESSAGE = 'Drafting is taking longer than expected. Reload to check.';

/** How a draft save ended; `failed` sets `error`, `conflict` does not. */
export type SaveDraftResult = 'saved' | 'conflict' | 'failed';

export interface KnowledgeProfile {
  state: ProfileState | null;
  loading: boolean;
  /** The last read or action failed, with why; cleared by the next success. */
  error: string | null;
  /** True while an action is in flight. */
  busy: boolean;
  reload: () => Promise<void>;
  /**
   * Saves the owner's edits over the draft they opened: `expectedVersion` is
   * that draft's `version`, or null when there was no draft. Resolves
   * `conflict` (writing nothing) when the draft has changed since; the state
   * is re-read either way, so it then holds the current draft.
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
    async (run: () => Promise<void>, fallback: string): Promise<boolean> => {
      setBusy(true);
      let failure: string | null = null;
      try {
        await run();
      } catch (err) {
        failure = errorMessage(err, fallback);
      }
      await reload();
      if (mounted.current) {
        setBusy(false);
        // A successful reload clears the error; the action's own failure stays.
        if (failure) setError(failure);
      }
      return failure === null;
    },
    [reload],
  );

  const saveDraft = useCallback(
    async (data: ProfileData, expectedVersion: number | null): Promise<SaveDraftResult> => {
      let conflict = false;
      const saved = await act(async () => {
        try {
          parseProfileResponse(
            await apiRequest('/knowledge/profile/draft', {
              method: 'PUT',
              body: JSON.stringify({ data, expectedVersion }),
            }),
          );
        } catch (err) {
          // The draft changed since it was opened: the caller asks the owner what to do.
          if (err instanceof ApiError && err.status === 409) {
            conflict = true;
            return;
          }
          throw err;
        }
      }, 'Could not save the draft');
      if (conflict) return 'conflict';
      return saved ? 'saved' : 'failed';
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

  const draftVersion = state?.draft?.version ?? null;
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

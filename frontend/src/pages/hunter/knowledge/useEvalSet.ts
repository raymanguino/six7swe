import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../../utils/api';
import { errorMessage } from '../../../utils/errorMessage';
import {
  parseEvalQuestionResponse,
  parseEvalState,
  type EvalQuestion,
  type EvalQuestionAction,
  type EvalState,
} from './evalTypes';

/** How often the set is re-read while a run is in progress. */
const POLL_INTERVAL_MS = 3000;
/** A run can call a model per question; give up following it after this long. */
const POLL_LIMIT_MS = 5 * 60 * 1000;
const RUN_TIMEOUT_MESSAGE = 'The eval run is taking longer than expected. Reload to check.';

export interface EvalSetState {
  state: EvalState | null;
  loading: boolean;
  /** The last read or action failed, with why; cleared by the next success. */
  error: string | null;
  /** The id of the question an action is in flight for, or `run` while queuing a run. */
  busy: string | null;
  /** The question retired to make room by the last promotion, if any. */
  lastEvicted: EvalQuestion | null;
  reload: () => Promise<void>;
  runNow: () => Promise<void>;
  act: (question: EvalQuestion, action: EvalQuestionAction) => Promise<void>;
}

/**
 * The owner's chat eval set through the backend's `/knowledge/eval*` proxy.
 * While a run is in progress the set is re-read until it settles, for at most
 * `POLL_LIMIT_MS`. `refreshKey` re-reads it from outside, e.g. when the
 * corpus changes and a run may have started.
 */
export function useEvalSet(enabled: boolean, refreshKey: string | null): EvalSetState {
  const [state, setState] = useState<EvalState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastEvicted, setLastEvicted] = useState<EvalQuestion | null>(null);
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
      const next = parseEvalState(await apiRequest('/knowledge/eval'));
      if (!mounted.current || seq !== loadSeq.current) return;
      setState(next);
      setError(null);
    } catch (err) {
      if (!mounted.current || seq !== loadSeq.current) return;
      setError(errorMessage(err, 'Failed to load the eval set'));
    } finally {
      if (mounted.current && seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload, refreshKey]);

  const running = state?.running === true;
  useEffect(() => {
    setPollStartedAt(running ? Date.now() : null);
  }, [running]);

  useEffect(() => {
    if (!enabled || pollStartedAt === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - pollStartedAt > POLL_LIMIT_MS) {
        if (mounted.current) setError(RUN_TIMEOUT_MESSAGE);
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

  const runNow = useCallback(async () => {
    setBusy('run');
    let failure: string | null = null;
    try {
      await apiRequest('/knowledge/eval/runs', { method: 'POST' });
    } catch (err) {
      failure = errorMessage(err, 'Could not start an eval run');
    }
    await reload();
    if (mounted.current) {
      setBusy(null);
      if (failure) setError(failure);
    }
  }, [reload]);

  const act = useCallback(
    async (question: EvalQuestion, action: EvalQuestionAction) => {
      setBusy(question.id);
      let failure: string | null = null;
      try {
        const result = parseEvalQuestionResponse(
          await apiRequest(`/knowledge/eval/questions/${encodeURIComponent(question.id)}`, {
            method: 'POST',
            body: JSON.stringify({ action }),
          }),
        );
        if (mounted.current) setLastEvicted(result.evicted);
      } catch (err) {
        failure = errorMessage(err, 'Could not update the question');
      }
      await reload();
      if (mounted.current) {
        setBusy(null);
        if (failure) setError(failure);
      }
    },
    [reload],
  );

  return { state, loading, error, busy, lastEvicted, reload, runNow, act };
}

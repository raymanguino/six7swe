import { SERVICE_KEY_HEADER } from '@six7swe/knowledge-types';
import type { FetchLike } from './ownerProxy';

export interface AwaitReadyOptions {
  baseUrl: string;
  serviceKey: string;
  /** Total time to wait before giving up (default 30 s). */
  timeoutMs?: number;
  /** Pause between attempts (default 500 ms). */
  intervalMs?: number;
  /** Per-request timeout (default 2 s). */
  requestTimeoutMs?: number;
  /** Called once, on the first failed attempt. */
  onWaiting?: () => void;
  fetchFn?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Polls the knowledge service's `GET /version` until it answers 200, so a
 * service that is restarting (tsx watch after a types rebuild) is not hit
 * while connections are refused. Resolves true once ready, false on timeout;
 * it never throws.
 */
export async function awaitKnowledgeReady(options: AwaitReadyOptions): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  const fetchFn: FetchLike = options.fetchFn ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${options.baseUrl.replace(/\/+$/, '')}/version`;
  const deadline = now() + timeoutMs;
  let warned = false;

  for (;;) {
    try {
      const res = await fetchFn(url, {
        method: 'GET',
        headers: { [SERVICE_KEY_HEADER]: options.serviceKey },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 200) return true;
    } catch {
      // Connection refused while the service restarts; try again.
    }
    if (!warned) {
      warned = true;
      options.onWaiting?.();
    }
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

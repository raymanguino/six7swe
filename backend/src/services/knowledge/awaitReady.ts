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

export type AwaitReadyResult =
  | { ready: true }
  | {
      ready: false;
      /** Why it stopped: the last retryable error on timeout, or the fatal cause. */
      reason: string;
      /** True when it only ran out of time on errors a restart produces. */
      retryable: boolean;
    };

const RETRYABLE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET']);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  if (typeof code === 'string') return code;
  return cause === undefined ? undefined : errorCode(cause);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

/** A network error or timeout of the kind a restarting service produces. */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return true;
  }
  const code = errorCode(error);
  if (code !== undefined) return RETRYABLE_NETWORK_CODES.has(code);
  // A fetch failure with no cause code is still a transport failure.
  return error instanceof TypeError && error.message === 'fetch failed';
}

function versionUrl(baseUrl: string): string | null {
  try {
    return new URL(`${baseUrl.replace(/\/+$/, '')}/version`).toString();
  } catch {
    return null;
  }
}

/**
 * Polls the knowledge service's `GET /version` until it answers 200, so a
 * service that is restarting (tsx watch after a types rebuild) is not hit
 * while connections are refused. Only what a restart produces is retried:
 * refused or reset connections, timeouts and HTTP 5xx. A 401/403, any other
 * 4xx, an invalid URL or any other error stops at once with a hint. It never
 * throws.
 */
export async function awaitKnowledgeReady(options: AwaitReadyOptions): Promise<AwaitReadyResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  const fetchFn: FetchLike = options.fetchFn ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = versionUrl(options.baseUrl);
  if (url === null) {
    return {
      ready: false,
      reason: 'KNOWLEDGE_URL is not a valid URL; check KNOWLEDGE_URL',
      retryable: false,
    };
  }
  const deadline = now() + timeoutMs;
  let warned = false;
  let lastReason: string;

  for (;;) {
    try {
      const res = await fetchFn(url, {
        method: 'GET',
        headers: { [SERVICE_KEY_HEADER]: options.serviceKey },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 200) return { ready: true };
      if (res.status === 401 || res.status === 403) {
        return {
          ready: false,
          reason: `HTTP ${res.status} from /version; check KNOWLEDGE_SERVICE_KEY`,
          retryable: false,
        };
      }
      if (res.status >= 400 && res.status < 500) {
        return {
          ready: false,
          reason: `HTTP ${res.status} from /version; check KNOWLEDGE_URL`,
          retryable: false,
        };
      }
      lastReason = `HTTP ${res.status} from /version`;
    } catch (error) {
      if (!isRetryableError(error)) {
        return { ready: false, reason: describeError(error), retryable: false };
      }
      lastReason = describeError(error);
    }
    if (!warned) {
      warned = true;
      options.onWaiting?.();
    }
    if (now() >= deadline) return { ready: false, reason: lastReason, retryable: true };
    await sleep(intervalMs);
  }
}

import type { KnowledgeProxyTarget } from '../../config/knowledge';

/**
 * Forwards an owner request to the knowledge service.
 *
 * The caller has already checked that the signed-in user is the owner; this
 * module only adds the owner key and relays the answer. The browser's
 * `Authorization` header is never forwarded: the service trusts the key, not
 * the user's token.
 */

/**
 * The knowledge service's key header (`SERVICE_KEY_HEADER` in its wire
 * contract). Duplicated until the contract moves to a shared package (#84).
 */
export const KNOWLEDGE_KEY_HEADER = 'x-knowledge-key';

/** Long enough for an upload to be stored; ingestion itself runs after the response. */
const DEFAULT_TIMEOUT_MS = 30_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ProxyRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path on the service, starting with `/`. Built by the caller, never taken from the client. */
  path: string;
  body?: Buffer | string;
  contentType?: string;
}

export interface ProxyResponse {
  status: number;
  /** The JSON body to relay; undefined for an empty response (204). */
  body?: unknown;
}

export interface ProxyOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Receives the details the response does not carry (status, cause). */
  onFailure?: (message: string, details: Record<string, unknown>) => void;
}

const failure = (status: number, error: string): ProxyResponse => ({ status, body: { error } });

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Sends the request and maps the outcome to what the browser should see:
 * - 2xx and 4xx pass through with their JSON body (validation errors, 404,
 *   409, 413 and 415 are the owner's to read);
 * - a 401 or 403 from the service means the backend's key is wrong, not that
 *   the user's session expired, so it becomes a 502 (the frontend would
 *   otherwise treat it as a sign-out);
 * - 5xx, an unreachable service and a timeout become 502 or 504 with a
 *   generic message; details go to `onFailure` only.
 */
export async function forwardToKnowledge(
  target: KnowledgeProxyTarget,
  request: ProxyRequest,
  options: ProxyOptions = {},
): Promise<ProxyResponse> {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const headers: Record<string, string> = { [KNOWLEDGE_KEY_HEADER]: target.ownerKey };
  if (request.contentType) headers['content-type'] = request.contentType;

  let response: Response;
  try {
    response = await doFetch(`${target.url}${request.path}`, {
      method: request.method,
      headers,
      // fetch's body types take an ArrayBuffer-backed view, which a pooled
      // Buffer is not typed as; the copy is at most one upload.
      body:
        typeof request.body === 'string'
          ? request.body
          : request.body && Uint8Array.from(request.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (error) {
    // AbortSignal.timeout rejects with a DOMException, which is not always an
    // `instanceof Error` across realms, so match on the name.
    const timedOut =
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'TimeoutError';
    options.onFailure?.('Knowledge service request failed', {
      path: request.path,
      err: error,
    });
    return timedOut
      ? failure(504, 'The knowledge service did not respond in time.')
      : failure(502, 'The knowledge service is unavailable.');
  }

  if (response.status === 401 || response.status === 403) {
    options.onFailure?.('Knowledge service rejected the owner key', {
      path: request.path,
      status: response.status,
    });
    return failure(502, 'The knowledge service rejected the backend credentials.');
  }
  if (response.status >= 500) {
    options.onFailure?.('Knowledge service error', {
      path: request.path,
      status: response.status,
    });
    return failure(502, 'The knowledge service failed to handle the request.');
  }

  const body = await readJson(response);
  if (response.status >= 400 && body === undefined) {
    return failure(response.status, `Request failed with status ${response.status}`);
  }
  return { status: response.status, body };
}

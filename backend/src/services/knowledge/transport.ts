import { SERVICE_KEY_HEADER } from '@six7swe/knowledge-types';

/**
 * The one HTTP transport to the private knowledge service, shared by the owner
 * proxy (`ownerProxy.ts`) and chat retrieval (`../knowledgeRetrieval.ts`).
 *
 * It owns what both need the same way: the base URL, the key header, the
 * per-request timeout (which covers reading the body), refusing redirects,
 * reading the body as text and the error type for a request that got no
 * answer. What a status or a body means differs per caller, so it stays there.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function errorField(err: unknown, field: 'name' | 'message'): string | undefined {
  if (typeof err !== 'object' || err === null || !(field in err)) return undefined;
  const value: unknown = (err as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The abort reason is a DOMException, which is not an `Error` instance in
 * every realm (Jest's sandbox, for one), so match on the name. `AbortError`
 * counts as a timeout only because the transport owns the only abort signal
 * (`AbortSignal.timeout`); a caller-supplied signal would need its own check.
 */
export function isTimeoutError(err: unknown): boolean {
  const name = errorField(err, 'name');
  return name === 'TimeoutError' || name === 'AbortError';
}

/** A request that got no answer: the service was unreachable or too slow. */
export class KnowledgeTransportError extends Error {
  readonly kind: 'timeout' | 'unreachable';
  /** The original failure (fetch's error or the abort reason). */
  readonly original: unknown;

  constructor(kind: 'timeout' | 'unreachable', original: unknown, timeoutMs: number) {
    super(
      kind === 'timeout'
        ? `timed out after ${timeoutMs} ms`
        : `unreachable: ${errorField(original, 'message') ?? String(original)}`,
    );
    this.name = 'KnowledgeTransportError';
    this.kind = kind;
    this.original = original;
  }
}

export interface KnowledgeRequest {
  /** Service base URL, without a trailing slash. */
  baseUrl: string;
  /** Sent in the service's key header. */
  key: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path on the service, starting with `/`. Built by the caller, never taken from the client. */
  path: string;
  body?: Buffer | string;
  contentType?: string;
  /** Covers the whole exchange, body included. */
  timeoutMs: number;
  fetch?: FetchLike;
}

export interface KnowledgeReply {
  status: number;
  /** The body as text; empty when there is none. */
  text: string;
}

/**
 * Sends the request and returns the status and body text, whatever the status.
 * Throws `KnowledgeTransportError` when there is no answer, including a
 * connection dropped or a timeout while the body is read.
 */
export async function sendKnowledgeRequest(request: KnowledgeRequest): Promise<KnowledgeReply> {
  const doFetch: FetchLike = request.fetch ?? ((url, init) => fetch(url, init));
  const headers: Record<string, string> = { [SERVICE_KEY_HEADER]: request.key };
  if (request.contentType) headers['content-type'] = request.contentType;

  try {
    const response = await doFetch(`${request.baseUrl}${request.path}`, {
      method: request.method,
      headers,
      // fetch's body types take an ArrayBuffer-backed view, which a pooled
      // Buffer is not typed as; the copy is at most one upload.
      body:
        typeof request.body === 'string'
          ? request.body
          : request.body && new Uint8Array(request.body),
      signal: AbortSignal.timeout(request.timeoutMs),
      redirect: 'error',
    });
    // Read inside the try: the timeout and a dropped connection can also
    // strike while the body streams in.
    return { status: response.status, text: await response.text() };
  } catch (error) {
    throw new KnowledgeTransportError(
      isTimeoutError(error) ? 'timeout' : 'unreachable',
      error,
      request.timeoutMs,
    );
  }
}

/** The parsed JSON body; undefined when it is empty or not JSON. */
export function parseJsonBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const API_URL = import.meta.env.VITE_API_URL || '';

export class ApiError extends Error {
  readonly status: number;
  /** The parsed JSON error body, if there was one (e.g. the current state a 409 carries). */
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** The failed response as an `ApiError`: its `error` message (or the status line) and body. */
const toApiError = async (response: Response): Promise<ApiError> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Non-JSON error body; fall back to the status line.
  }
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { error } = body as { error: unknown };
    if (typeof error === 'string' && error) {
      return new ApiError(error, response.status, body);
    }
  }
  return new ApiError(`Request failed with status ${response.status}`, response.status, body);
};

type AccessTokenProvider = () => Promise<string | null>;

let accessTokenProvider: AccessTokenProvider | null = null;

/**
 * Registers the source of the current access token.
 *
 * The auth context installs itself here so any call can attach the token
 * without every caller having to thread it through.
 */
export const setAccessTokenProvider = (provider: AccessTokenProvider | null): void => {
  accessTokenProvider = provider;
};

/** The URL of an API path: `VITE_API_URL` when set, else the `/api` proxy prefix. */
export const apiUrl = (endpoint: string): string =>
  API_URL ? `${API_URL}${endpoint}` : `/api${endpoint}`;

export const apiRequest = async (endpoint: string, options: RequestInit = {}) => {
  const url = apiUrl(endpoint);

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  };

  // Only declare a JSON body when there actually is one. Sending
  // `Content-Type: application/json` with an empty body makes Fastify reject
  // the request with FST_ERR_CTP_EMPTY_JSON_BODY, which broke bodyless POSTs
  // such as starting a job refresh. A caller-supplied Content-Type wins.
  // FormData is left alone: the browser sets multipart/form-data with its
  // boundary, which a hand-written header would lose.
  const hasBody = options.body !== undefined && options.body !== null;
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (hasBody && !isFormData && headers['Content-Type'] === undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (accessTokenProvider) {
    const token = await accessTokenProvider();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  if (response.status === 204) {
    return undefined;
  }

  return response.json();
};

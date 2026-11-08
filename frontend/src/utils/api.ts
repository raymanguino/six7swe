const API_URL = import.meta.env.VITE_API_URL || '';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const { error } = body as { error: unknown };
      if (typeof error === 'string' && error) {
        return error;
      }
    }
  } catch {
    // Non-JSON error body; fall back to the status line.
  }
  return `Request failed with status ${response.status}`;
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

export const apiRequest = async (endpoint: string, options: RequestInit = {}) => {
  const url = API_URL ? `${API_URL}${endpoint}` : `/api${endpoint}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

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
    throw new ApiError(await readErrorMessage(response), response.status);
  }

  if (response.status === 204) {
    return undefined;
  }

  return response.json();
};

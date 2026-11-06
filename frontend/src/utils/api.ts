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

export const apiRequest = async (endpoint: string, options: RequestInit = {}) => {
  const url = API_URL ? `${API_URL}${endpoint}` : `/api${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }

  return response.json();
};

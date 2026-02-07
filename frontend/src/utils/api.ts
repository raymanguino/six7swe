const API_URL = import.meta.env.VITE_API_URL || '';

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
    throw new Error(`API request failed: ${response.statusText}`);
  }

  return response.json();
};

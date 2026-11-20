import { useEffect, useState } from 'react';
import { apiUrl } from '../utils/api';

/**
 * Whether `GET /resume` will return a PDF: a HEAD probe on mount. False while pending, on a 404
 * or 5xx, and on a network error, so the download link is only shown when it will work.
 */
export function useResumeAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(apiUrl('/resume'), { method: 'HEAD', signal: controller.signal })
      .then((response) => setAvailable(response.ok))
      .catch(() => {
        // Aborted on unmount, or the backend is unreachable: no link.
      });
    return () => controller.abort();
  }, []);

  return available;
}

const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5_000;

/**
 * Retries an operation with exponential backoff and full jitter.
 *
 * The previous implementation retried immediately with no delay, which hammered
 * the target on every failure and made rate limiting more likely.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
): Promise<T> {
  let attempt = 0;

  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries) {
        throw error;
      }

      const ceiling = Math.min(DEFAULT_MAX_DELAY_MS, baseDelayMs * 2 ** attempt);
      await sleep(Math.random() * ceiling);
      attempt += 1;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

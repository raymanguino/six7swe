// A simple retry utility function. Can be expanded with backoff strategies if needed.
export async function retry(fn: () => Promise<any>, retries = 3): Promise<any> {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) {
      throw error;
    }
    return await retry(fn, retries - 1);
  }
}

/**
 * Runs an async mapper over a list with a bounded number of concurrent tasks.
 *
 * Used to keep the number of in-flight model calls and page loads inside a
 * limit that the upstream service will tolerate.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: limit }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

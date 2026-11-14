import { useState } from 'react';
import { apiRequest } from '../../../utils/api';
import { errorMessage } from '../../../utils/errorMessage';
import { DEFAULT_SEARCH_K, MAX_SEARCH_K, parseSearch, type SearchResponse } from './types';

/**
 * "Ask as a visitor": runs the retrieval the public chat will use and shows
 * the chunks it would get, with their cosine similarity.
 */
export default function SearchPlayground() {
  const [query, setQuery] = useState('');
  const [k, setK] = useState(DEFAULT_SEARCH_K);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const data: unknown = await apiRequest('/knowledge/search', {
        method: 'POST',
        body: JSON.stringify({ query: query.trim(), k }),
      });
      setResult(parseSearch(data));
    } catch (err) {
      setError(errorMessage(err, 'Search failed'));
    } finally {
      setSearching(false);
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Ask as a visitor</h3>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
        See which chunks a visitor&apos;s question retrieves, closest first.
      </p>

      <form onSubmit={handleSearch} className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1">
          <label
            htmlFor="knowledge-query"
            className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Question
          </label>
          <input
            id="knowledge-query"
            value={query}
            maxLength={2000}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Which projects used Kafka?"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
          />
        </div>
        <div>
          <label
            htmlFor="knowledge-k"
            className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Chunks
          </label>
          <select
            id="knowledge-k"
            value={k}
            onChange={(e) => setK(Number(e.target.value))}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
          >
            {Array.from({ length: MAX_SEARCH_K }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={searching || !query.trim()}
          className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {searching ? 'Searching...' : 'Search'}
        </button>
      </form>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-6 space-y-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Corpus version {result.version} · {result.chunks.length} chunk
            {result.chunks.length === 1 ? '' : 's'}
          </p>
          {result.chunks.length === 0 ? (
            <p className="text-sm text-gray-500">
              Nothing retrieved. Only documents with status ready are searched.
            </p>
          ) : (
            <ol className="space-y-3">
              {result.chunks.map((chunk) => (
                <li
                  key={chunk.chunkId}
                  className="rounded-lg border border-gray-200 p-4 dark:border-gray-700"
                >
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      {chunk.filename}
                      {chunk.heading && (
                        <span className="font-normal text-gray-500 dark:text-gray-400">
                          {' '}
                          · {chunk.heading}
                        </span>
                      )}
                    </p>
                    <span className="font-mono text-xs tabular-nums text-gray-600 dark:text-gray-300">
                      similarity {chunk.similarity.toFixed(4)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">
                    {chunk.content}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

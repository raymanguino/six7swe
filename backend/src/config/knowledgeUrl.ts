/**
 * The knowledge service's base URL, read one way for every caller (owner
 * proxy, chat retrieval, the readiness probe, the eval's document client).
 * Only http and https are accepted, without a username or password, query or fragment (fetch rejects
 * those and its error text can repeat the URL into the logs); trailing slashes are stripped so paths
 * join with a single `/`.
 */
export function normalizeKnowledgeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  // A query or fragment would be glued into the path the transport appends. `new URL` leaves a
  // bare trailing `?` or `#` empty, so the raw string is checked too.
  if (parsed.search || parsed.hash || /[?#]/.test(trimmed)) return null;
  return trimmed.replace(/\/+$/, '');
}

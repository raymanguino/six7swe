/**
 * The knowledge service's base URL, read one way for every caller (owner
 * proxy, chat retrieval, the readiness probe, the eval's document client).
 * Only http and https are accepted; trailing slashes are stripped so paths
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
  return trimmed.replace(/\/+$/, '');
}

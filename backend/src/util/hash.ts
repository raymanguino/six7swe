// Simple hash function for computing diffs.
export function hashData(data: string): string {
  let hash = 0, i, chr;
  for (i = 0; i < data.length; i++) {
    chr   = data.charCodeAt(i);
    hash  = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString();
}
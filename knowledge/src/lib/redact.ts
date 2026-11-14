/**
 * Masks secrets in provider text before it reaches the logs. A copy of the
 * backend's `redactSecrets` (`backend/src/util/redact.ts`), which this service
 * cannot import, plus the literal values of the keys the caller sent.
 */

const MAX_UPSTREAM_BODY_LENGTH = 500;

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /re_[A-Za-z0-9_-]{16,}/g,
  /sb_secret_[A-Za-z0-9_-]{16,}/g,
  /x-brain-key["':=\s]+[A-Za-z0-9_-]{16,}/gi,
  // GitHub personal access tokens: classic (ghp_/gho_/ghu_/ghs_/ghr_) and
  // fine-grained (github_pat_).
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

/**
 * Masks `knownSecrets` wherever they appear (before truncating, so a key cut
 * in half cannot slip through), then known secret formats, then truncates.
 */
export function redactSecrets(text: string, knownSecrets: Array<string | undefined> = []): string {
  let output = text;
  for (const secret of knownSecrets) {
    if (secret) output = output.split(secret).join('[redacted]');
  }
  output = output.slice(0, MAX_UPSTREAM_BODY_LENGTH);
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, '[redacted]');
  }
  return output;
}

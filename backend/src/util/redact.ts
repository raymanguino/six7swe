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
];

/** Truncates an upstream response body and masks known secret formats. */
export function redactSecrets(text: string): string {
  let output = text.slice(0, MAX_UPSTREAM_BODY_LENGTH);
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, '[redacted]');
  }
  return output;
}

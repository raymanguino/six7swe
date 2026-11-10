import { redactSecrets } from '../../util/redact';

describe('redactSecrets', () => {
  it('masks a MiniMax key', () => {
    expect(redactSecrets('key is sk-abcdefghijklmnopqrstuvwxyz')).toContain('[redacted]');
  });

  it('masks a Resend key', () => {
    expect(redactSecrets('key is re_abcdefghijklmnopqrstuvwxyz')).toContain('[redacted]');
  });

  it('masks a Supabase secret', () => {
    expect(redactSecrets('key is sb_secret_abcdefghijklmnopqrstuv')).toContain('[redacted]');
  });

  it('masks a classic GitHub personal access token', () => {
    expect(redactSecrets('token ghp_abcdefghijklmnopqrstuvwxyz012345')).toContain('[redacted]');
  });

  it('masks a fine-grained GitHub personal access token', () => {
    expect(redactSecrets('token github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz')).toContain(
      '[redacted]',
    );
  });

  it('masks a GitHub App installation token', () => {
    expect(redactSecrets('token ghs_abcdefghijklmnopqrstuvwxyz012345')).toContain('[redacted]');
  });

  it('masks every classic GitHub token prefix', () => {
    for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
      expect(redactSecrets(`token ${prefix}abcdefghijklmnopqrstuvwxyz012345`)).toContain(
        '[redacted]',
      );
    }
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('nothing secret here')).toBe('nothing secret here');
  });

  it('truncates a long body', () => {
    expect(redactSecrets('a'.repeat(1000)).length).toBe(500);
  });
});

import { describe, expect, it } from 'vitest';
import { describeError } from '../lib/describeError.js';

describe('describeError', () => {
  it('prints the message, and the cause when it is an Error', () => {
    expect(describeError(new Error('Failed query'))).toBe('Failed query');
    expect(
      describeError(new Error('Failed query', { cause: new Error('relation "x" does not exist') })),
    ).toBe('Failed query\n  cause: relation "x" does not exist');
  });

  it('ignores a non-Error cause and stringifies non-errors', () => {
    expect(describeError(new Error('outer', { cause: 'just a string' }))).toBe('outer');
    expect(describeError('plain')).toBe('plain');
    expect(describeError(42)).toBe('42');
  });
});

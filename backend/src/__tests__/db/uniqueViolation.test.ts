/**
 * drizzle-orm wraps driver errors in `DrizzleQueryError`, so the Postgres
 * code is on `error.cause`. These tests push wrapped errors through the real
 * store wrappers (with `db` mocked: postgres 4 is ESM-only and Jest cannot
 * load it).
 */

jest.mock('../../db/index', () => ({
  db: { insert: jest.fn(), select: jest.fn() },
}));

import { DrizzleQueryError } from 'drizzle-orm';
import { db } from '../../db/index';
import { isUniqueViolation } from '../../db/uniqueViolation';
import { findOrCreateUserByAuthId } from '../../db/api/user';
import { newProfileRefreshStatus } from '../../db/api/refreshStatus';
import { ActiveRefreshExistsError } from '../../domain/jobHunt';

const mockDb = db as unknown as { insert: jest.Mock; select: jest.Mock };

function pgError(code: string): Error {
  return Object.assign(new Error('driver error'), { code });
}

function wrapped(code: string): DrizzleQueryError {
  return new DrizzleQueryError('insert ...', [], pgError(code));
}

/** insert(...).values(...).returning() rejecting with the given error. */
function insertRejects(error: unknown): void {
  mockDb.insert.mockReturnValue({
    values: () => ({ returning: () => Promise.reject(error) }),
  });
}

/** select().from().where() resolving to each given row set in turn. */
function selectResolves(...results: unknown[][]): void {
  for (const rows of results) {
    mockDb.select.mockReturnValueOnce({
      from: () => ({ where: () => Promise.resolve(rows) }),
    });
  }
}

beforeEach(() => {
  mockDb.insert.mockReset();
  mockDb.select.mockReset();
});

describe('isUniqueViolation', () => {
  it('matches a top-level code', () => {
    expect(isUniqueViolation(pgError('23505'))).toBe(true);
  });

  it('matches a code on a wrapped cause', () => {
    expect(isUniqueViolation(wrapped('23505'))).toBe(true);
  });

  it('rejects other codes and non-objects', () => {
    expect(isUniqueViolation(wrapped('23503'))).toBe(false);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const a: { cause?: unknown } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b;
    expect(isUniqueViolation(a)).toBe(false);
  });
});

describe('findOrCreateUserByAuthId with a wrapped unique violation', () => {
  const winner = { id: 7, name: 'A', email: null, authId: 'auth-1' };

  it('re-reads the winning row instead of failing', async () => {
    // findByAuthId misses, the insert loses the race, the re-read finds the winner.
    selectResolves([], [winner]);
    insertRejects(wrapped('23505'));

    await expect(findOrCreateUserByAuthId({ authId: 'auth-1', email: null })).resolves.toEqual(
      winner,
    );
  });

  it('rethrows a wrapped error that is not a unique violation', async () => {
    selectResolves([]);
    const error = wrapped('23503');
    insertRejects(error);

    await expect(findOrCreateUserByAuthId({ authId: 'auth-1', email: null })).rejects.toBe(error);
  });

  it('falls back to inserting without the email when the address is taken', async () => {
    const created = { id: 9, name: 'a', email: null, authId: 'auth-1' };
    // findByAuthId misses, findUnclaimedByEmail misses (it ends in .limit()),
    // then the re-read after the lost insert misses too.
    selectResolves([]);
    mockDb.select.mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    });
    selectResolves([]);

    const values = jest
      .fn()
      .mockReturnValueOnce({ returning: () => Promise.reject(wrapped('23505')) })
      .mockReturnValueOnce({ returning: () => Promise.resolve([created]) });
    mockDb.insert.mockReturnValue({ values });

    await expect(
      findOrCreateUserByAuthId({ authId: 'auth-1', email: 'a@x.com' }),
    ).resolves.toEqual(created);

    expect(values).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenNthCalledWith(1, expect.objectContaining({ email: 'a@x.com' }));
    expect(values).toHaveBeenLastCalledWith(expect.objectContaining({ email: null }));
  });
});

describe('newProfileRefreshStatus with a wrapped unique violation', () => {
  it('reports an active refresh', async () => {
    insertRejects(wrapped('23505'));

    await expect(newProfileRefreshStatus(3)).rejects.toBeInstanceOf(ActiveRefreshExistsError);
  });

  it('rethrows a wrapped error that is not a unique violation', async () => {
    const error = wrapped('23503');
    insertRejects(error);

    await expect(newProfileRefreshStatus(3)).rejects.toBe(error);
  });
});

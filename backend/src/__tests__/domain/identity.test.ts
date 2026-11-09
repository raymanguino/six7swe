import {
  resolveIdentity,
  type IdentityRecord,
  type IdentityStore,
} from '../../domain/jobHunt/identity';

/**
 * Guards the identity contract.
 *
 * A local row may only ever be bound to one authenticated subject. If a
 * second subject can take a row that is already owned, it inherits the
 * account, the search profiles and the job matches of the first one.
 *
 * `auth_id` is the identity. The email is an attribute: a subject may have
 * none, and two subjects may present the same one.
 */

interface Row extends IdentityRecord {
  id: number;
  name: string;
  email: string | null;
  authId: string | null;
}

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    name: 'Test User',
    email: 'user@example.com',
    authId: 'auth-1',
    ...overrides,
  };
}

/**
 * An in-memory store with the same guarantees as the SQL one: `claimUnclaimed`
 * only succeeds while the row is unowned, and `insert` only rejects a
 * duplicate `auth_id` or email.
 */
function makeStore(rows: Row[] = []) {
  const state = { rows: [...rows] };

  const store: IdentityStore<Row> = {
    async findByAuthId(authId) {
      return state.rows.find((row) => row.authId === authId) ?? null;
    },

    async findUnclaimedByEmail(email) {
      return state.rows.find((row) => row.email === email && row.authId === null) ?? null;
    },

    async claimUnclaimed(id, authId) {
      const row = state.rows.find((candidate) => candidate.id === id);
      if (!row || row.authId !== null) {
        return null;
      }
      row.authId = authId;
      return row;
    },

    async insert(values) {
      // Both columns carry a unique index, so either one can reject the
      // insert the same way the database would.
      const duplicateAuthId = state.rows.find((row) => row.authId === values.authId);
      if (duplicateAuthId) {
        return null;
      }
      const duplicateEmail =
        values.email !== null && state.rows.find((row) => row.email === values.email);
      if (duplicateEmail) {
        return null;
      }
      const created: Row = {
        id: state.rows.length + 1,
        name: values.name,
        email: values.email,
        authId: values.authId,
      };
      state.rows.push(created);
      return created;
    },
  };

  return { store, state };
}

describe('resolveIdentity', () => {
  it('returns the row that already owns the auth id', async () => {
    const owned = makeRow({ id: 7, authId: 'auth-1' });
    const { store } = makeStore([owned]);

    const result = await resolveIdentity(store, {
      authId: 'auth-1',
      email: 'user@example.com',
    });

    expect(result).toBe(owned);
  });

  it('does not take over a row that another subject already owns', async () => {
    // The row belongs to auth-1. A second subject presenting the same email
    // must not be handed that row.
    const owned = makeRow({ id: 7, authId: 'auth-1' });
    const { store, state } = makeStore([owned]);

    const result = await resolveIdentity(store, {
      authId: 'auth-2',
      email: 'user@example.com',
    });

    // The other subject keeps the row and the email that goes with it.
    expect(owned.authId).toBe('auth-1');
    expect(state.rows.filter((row) => row.email === 'user@example.com')).toHaveLength(1);

    // The new subject gets an account of its own, without the address
    // that is already taken.
    expect(result.authId).toBe('auth-2');
    expect(result.id).not.toBe(owned.id);
    expect(result.email).toBeNull();
  });

  it('claims a row that nobody owns yet', async () => {
    const unclaimed = makeRow({ id: 7, authId: null });
    const { store } = makeStore([unclaimed]);

    const result = await resolveIdentity(store, {
      authId: 'auth-1',
      email: 'user@example.com',
    });

    expect(result.id).toBe(7);
    expect(result.authId).toBe('auth-1');
  });

  it('creates a row when nothing matches', async () => {
    const { store } = makeStore();

    const result = await resolveIdentity(store, {
      authId: 'auth-1',
      email: 'user@example.com',
    });

    expect(result.authId).toBe('auth-1');
    expect(result.email).toBe('user@example.com');
    expect(result.name).toBe('user');
  });

  it('creates a row without an email when the token carries no email claim', async () => {
    const { store } = makeStore();

    const result = await resolveIdentity(store, { authId: 'auth-1', email: null });

    expect(result.authId).toBe('auth-1');
    expect(result.email).toBeNull();
    expect(result.name).toBe('User');
  });

  it('does not look for a row to claim when there is no email claim', async () => {
    const unclaimed = makeRow({ id: 7, authId: null });
    const { store } = makeStore([unclaimed]);

    const findUnclaimedByEmail = jest.spyOn(store, 'findUnclaimedByEmail');

    const result = await resolveIdentity(store, { authId: 'auth-1', email: null });

    expect(findUnclaimedByEmail).not.toHaveBeenCalled();
    expect(result.id).not.toBe(7);
  });

  it('gives each subject its own row when two present the same email', async () => {
    // Neither row is owned yet, so the first subject claims the waiting
    // row and the second one cannot take it.
    const waiting = makeRow({ id: 7, authId: null });
    const { store } = makeStore([waiting]);

    const first = await resolveIdentity(store, {
      authId: 'auth-1',
      email: 'user@example.com',
    });
    const second = await resolveIdentity(store, {
      authId: 'auth-2',
      email: 'user@example.com',
    });

    expect(first.id).toBe(7);
    expect(second.authId).toBe('auth-2');
    expect(second.id).not.toBe(first.id);
    expect(waiting.authId).toBe('auth-1');
  });

  it('returns the row that won when two requests create the same subject', async () => {
    const winner = makeRow({ id: 9, authId: 'auth-1' });
    let inserted = false;

    const store: IdentityStore<Row> = {
      async findByAuthId(_authId) {
        return inserted ? winner : null;
      },
      async findUnclaimedByEmail() {
        return null;
      },
      async claimUnclaimed() {
        return null;
      },
      async insert() {
        // The insert loses the race; the row exists by the time the loser
        // reads it back.
        inserted = true;
        return null;
      },
    };

    const result = await resolveIdentity(store, {
      authId: 'auth-1',
      email: 'user@example.com',
    });

    expect(result).toBe(winner);
  });

  it('keeps the subject that lost the insert race when the email is taken', async () => {
    // The insert is rejected because the email belongs to somebody else,
    // so this subject gets its own row without the address.
    const other = makeRow({ id: 3, authId: 'auth-other' });
    const store: IdentityStore<Row> = {
      async findByAuthId(authId) {
        return authId === 'auth-other' ? other : null;
      },
      async findUnclaimedByEmail() {
        return null;
      },
      async claimUnclaimed() {
        return null;
      },
      async insert(input) {
        if (input.email !== null) {
          return null;
        }
        return makeRow({ id: 11, name: input.name, email: null, authId: input.authId });
      },
    };

    const result = await resolveIdentity(store, {
      authId: 'auth-1',
      email: 'user@example.com',
    });

    expect(result.id).toBe(11);
    expect(result.email).toBeNull();
    expect(other.authId).toBe('auth-other');
  });
});

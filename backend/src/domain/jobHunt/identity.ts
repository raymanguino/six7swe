/**
 * Identity resolution.
 *
 * Pure domain logic. Which local row an authenticated subject maps to is a
 * policy decision, not a data-access detail, so it lives here where it can
 * be stated once and tested in isolation.
 *
 * The rule that matters: a row that already belongs to a subject is never
 * re-bound. `auth_id` is the identity; the email is an attribute that a
 * subject may or may not have.
 */

/** A local user row, as far as the identity policy is concerned. */
export interface IdentityRecord {
  id: number;
  name: string;
  /** Null when the subject carries no email claim. */
  email: string | null;
  /** Null while nobody owns the row yet. */
  authId: string | null;
}

/**
 * The data operations the policy needs.
 *
 * The store owns the concurrency guarantees: `claimUnclaimed` and `insert`
 * are the points where two requests can race, and both are written so that
 * only one of them can win.
 */
export interface IdentityStore<TRecord extends IdentityRecord = IdentityRecord> {
  /** The row that already owns this auth id, if any. */
  findByAuthId(authId: string): Promise<TRecord | null>;
  /** The row for this email that nobody owns yet, if any. */
  findUnclaimedByEmail(email: string): Promise<TRecord | null>;
  /**
   * Takes ownership of a row that nobody owns.
   *
   * Returns null when another subject claimed it first.
   */
  claimUnclaimed(id: number, authId: string): Promise<TRecord | null>;
  /** Inserts a row; returns null when a unique constraint rejected it. */
  insert(input: { name: string; email: string | null; authId: string }): Promise<TRecord | null>;
}

export interface IdentityRequest {
  /** The subject id from the verified token. */
  authId: string;
  /** The email claim, when the token carries one. */
  email: string | null;
  name?: string;
}

/**
 * Returns the local row for an authenticated subject, creating it on first
 * sign-in.
 */
export async function resolveIdentity<TRecord extends IdentityRecord>(
  store: IdentityStore<TRecord>,
  request: IdentityRequest,
): Promise<TRecord> {
  const existing = await store.findByAuthId(request.authId);
  if (existing) {
    return existing;
  }

  const claimed = await claimUnclaimedRow(store, request);
  if (claimed) {
    return claimed;
  }

  return createIdentityRow(store, request);
}

/**
 * Claims the row that waits for this email, but only while nobody owns it.
 *
 * A row without an auth id is waiting to be taken: a seeded row, or one left
 * behind by a previous auth method. A row that already has an auth id
 * belongs to someone else and must never be re-bound, because that would
 * hand this subject the account, profiles and matches of its owner.
 */
async function claimUnclaimedRow<TRecord extends IdentityRecord>(
  store: IdentityStore<TRecord>,
  request: IdentityRequest,
): Promise<TRecord | null> {
  if (!request.email) {
    return null;
  }

  const unclaimed = await store.findUnclaimedByEmail(request.email);
  if (!unclaimed) {
    return null;
  }

  // The store claims atomically: when two subjects race for the same
  // unclaimed row, only one of them is told it won.
  return store.claimUnclaimed(unclaimed.id, request.authId);
}

/**
 * Inserts a new row for this subject.
 *
 * Two requests for the same subject can both miss the lookup above and both
 * insert. The unique index on auth_id lets exactly one of them win, so the
 * loser re-reads and returns the row that won.
 */
async function createIdentityRow<TRecord extends IdentityRecord>(
  store: IdentityStore<TRecord>,
  request: IdentityRequest,
): Promise<TRecord> {
  const name = request.name?.trim() || request.email?.split('@')[0] || 'User';

  const inserted = await store.insert({
    name,
    email: request.email,
    authId: request.authId,
  });
  if (inserted) {
    return inserted;
  }

  // The insert lost a race on auth_id: another request created this
  // identity first, so its row is the one to return.
  const winner = await store.findByAuthId(request.authId);
  if (winner) {
    return winner;
  }

  // The insert lost a race on email: the address already belongs to a
  // different subject. This subject still gets its own row, just without
  // the address. One subject must not be able to take over another
  // subject's account by presenting the same email.
  const withoutEmail = await store.insert({
    name,
    email: null,
    authId: request.authId,
  });
  if (withoutEmail) {
    return withoutEmail;
  }

  const retried = await store.findByAuthId(request.authId);
  if (retried) {
    return retried;
  }

  throw new Error('Failed to create user');
}

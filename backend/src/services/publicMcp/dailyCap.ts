/**
 * Budgets of uses per UTC day, kept in this process's memory (#205). The
 * backend runs one replica, so a budget is global across all clients; a
 * restart resets the day's counts.
 */
export interface DailyCap {
  /**
   * Spends one use of `key`'s budget on the UTC day of `at` (default: now);
   * false, and nothing spent, when that day's budget is gone or the day has
   * already passed.
   */
  tryTake(key?: string, at?: number): boolean;
  /**
   * Gives back one use, e.g. when the work it paid for failed. With
   * `takenAt` (the `at` of the take), a use charged to a day that has since
   * rolled is not given back: its counts are gone, and taking one off today's
   * would credit a use nobody gave back.
   */
  refund(key?: string, takenAt?: number): void;
  /** Uses left today for `key`. */
  remaining(key?: string): number;
}

/** The UTC calendar day, e.g. `2026-11-20`. ISO dates compare in order as strings. */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * `limit` uses per key per UTC day. Without a key every call shares one
 * budget; with one (a client key) each key has its own. All counts are
 * dropped at the day's roll, so the map holds at most a day of keys.
 */
export function createDailyCap(limit: number, now: () => number = Date.now): DailyCap {
  let day = utcDay(now());
  const used = new Map<string, number>();

  /** Moves to `at`'s day when it is later; never back to an earlier one. */
  function roll(at: number): void {
    const next = utcDay(at);
    if (next > day) {
      day = next;
      used.clear();
    }
  }

  return {
    tryTake(key = '', at = now()) {
      roll(at);
      if (utcDay(at) !== day) return false;
      const n = used.get(key) ?? 0;
      if (n >= limit) return false;
      used.set(key, n + 1);
      return true;
    },
    refund(key = '', takenAt?: number) {
      roll(now());
      if (takenAt !== undefined && utcDay(takenAt) !== day) return;
      const n = used.get(key) ?? 0;
      if (n <= 1) used.delete(key);
      else used.set(key, n - 1);
    },
    remaining(key = '') {
      roll(now());
      return Math.max(0, limit - (used.get(key) ?? 0));
    },
  };
}

/** Why a search was refused. */
export type SearchRefusal = 'global' | 'client';

/**
 * The daily budgets of `search_background`:
 * - searches: a global cap (each costs an embedding) and a per-client one,
 *   so a single client cannot spend everyone's day;
 * - recorded searches: only some searches are recorded in the eval set, a
 *   global and a per-client allowance, so public searches cannot flood the
 *   owner's candidate pool and push out the chat visitors' questions.
 */
export interface SearchBudget {
  /**
   * The time one request's takes and refunds are charged at. Read it once
   * and pass it to every call for that request, so they all land on the same
   * UTC day even when the request straddles midnight.
   */
  now(): number;
  /** Takes a search for `client`, or says which cap refused it (nothing spent then). */
  takeSearch(client: string, at: number): SearchRefusal | null;
  /** Gives back a search whose retrieval failed; not when its day has rolled. */
  refundSearch(client: string, at: number): void;
  /** Whether this search may be recorded; spends the allowance when it may. */
  takeRecord(client: string, at: number): boolean;
  /** Gives back a record allowance whose retrieval failed; not when its day has rolled. */
  refundRecord(client: string, at: number): void;
}

export interface SearchBudgetLimits {
  dailySearchCap: number;
  clientDailySearchCap: number;
  dailyRecordCap: number;
  clientDailyRecordCap: number;
}

export function createSearchBudget(
  limits: SearchBudgetLimits,
  now: () => number = Date.now,
): SearchBudget {
  const searches = createDailyCap(limits.dailySearchCap, now);
  const clientSearches = createDailyCap(limits.clientDailySearchCap, now);
  const records = createDailyCap(limits.dailyRecordCap, now);
  const clientRecords = createDailyCap(limits.clientDailyRecordCap, now);

  return {
    now,
    takeSearch(client, at) {
      if (!clientSearches.tryTake(client, at)) return 'client';
      if (!searches.tryTake('', at)) {
        clientSearches.refund(client, at);
        return 'global';
      }
      return null;
    },
    refundSearch(client, at) {
      searches.refund('', at);
      clientSearches.refund(client, at);
    },
    takeRecord(client, at) {
      if (!clientRecords.tryTake(client, at)) return false;
      if (!records.tryTake('', at)) {
        clientRecords.refund(client, at);
        return false;
      }
      return true;
    },
    refundRecord(client, at) {
      records.refund('', at);
      clientRecords.refund(client, at);
    },
  };
}

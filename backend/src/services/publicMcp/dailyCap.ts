/**
 * Budgets of uses per UTC day, kept in this process's memory (#205). The
 * backend runs one replica, so a budget is global across all clients; a
 * restart resets the day's counts.
 */
export interface DailyCap {
  /** Spends one use of `key`'s budget; false (and nothing spent) when today's is gone. */
  tryTake(key?: string): boolean;
  /**
   * Gives back one use, e.g. when the work it paid for failed. With
   * `takenOn` (from `today()` at the take), a use taken before the day rolled
   * is not given back: it was charged to a day whose counts are gone.
   */
  refund(key?: string, takenOn?: string): void;
  /** Uses left today for `key`. */
  remaining(key?: string): number;
  /** The current UTC day, to pass to `refund` as `takenOn`. */
  today(): string;
}

/** The UTC calendar day, e.g. `2026-11-20`. */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * `limit` uses per key per UTC day. Without a key every call shares one
 * budget; with one (a client key) each key has its own. All counts are
 * dropped at the day's roll, so the map holds at most a day of keys.
 */
export function createDailyCap(limit: number, now: () => number = Date.now): DailyCap {
  let day = utcDay(now());
  const used = new Map<string, number>();

  function roll(): void {
    const today = utcDay(now());
    if (today !== day) {
      day = today;
      used.clear();
    }
  }

  return {
    tryTake(key = '') {
      roll();
      const n = used.get(key) ?? 0;
      if (n >= limit) return false;
      used.set(key, n + 1);
      return true;
    },
    refund(key = '', takenOn?: string) {
      roll();
      if (takenOn !== undefined && takenOn !== day) return;
      const n = used.get(key) ?? 0;
      if (n <= 1) used.delete(key);
      else used.set(key, n - 1);
    },
    remaining(key = '') {
      roll();
      return Math.max(0, limit - (used.get(key) ?? 0));
    },
    today() {
      roll();
      return day;
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
  /** Takes a search for `client`, or says which cap refused it (nothing spent then). */
  takeSearch(client: string): SearchRefusal | null;
  /**
   * Gives back a search whose retrieval failed. `takenOn` is `today()` at the
   * take: a search taken before the UTC day rolled is not given back.
   */
  refundSearch(client: string, takenOn: string): void;
  /** Whether this search may be recorded; spends the allowance when it may. */
  takeRecord(client: string): boolean;
  /** Gives back a record allowance whose retrieval failed (see `refundSearch`). */
  refundRecord(client: string, takenOn: string): void;
  /** The current UTC day, read just before a take and passed to the refunds. */
  today(): string;
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
    takeSearch(client) {
      if (!clientSearches.tryTake(client)) return 'client';
      if (!searches.tryTake()) {
        clientSearches.refund(client);
        return 'global';
      }
      return null;
    },
    refundSearch(client, takenOn) {
      searches.refund('', takenOn);
      clientSearches.refund(client, takenOn);
    },
    takeRecord(client) {
      if (!clientRecords.tryTake(client)) return false;
      if (!records.tryTake()) {
        clientRecords.refund(client);
        return false;
      }
      return true;
    },
    refundRecord(client, takenOn) {
      records.refund('', takenOn);
      clientRecords.refund(client, takenOn);
    },
    // Every cap reads the same clock, so any of them names the day.
    today: () => searches.today(),
  };
}

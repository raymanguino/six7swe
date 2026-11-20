/**
 * A global budget of `limit` uses per UTC day, kept in this process's memory
 * (#205). The backend runs one replica, so this is the cap across all
 * clients; a restart resets the day's count.
 */
export interface DailyCap {
  /** Spends one use; false (and nothing spent) when today's budget is gone. */
  tryTake(): boolean;
  /** Uses left today. */
  remaining(): number;
}

/** The UTC calendar day, e.g. `2026-11-20`. */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function createDailyCap(limit: number, now: () => number = Date.now): DailyCap {
  let day = utcDay(now());
  let used = 0;

  function roll(): void {
    const today = utcDay(now());
    if (today !== day) {
      day = today;
      used = 0;
    }
  }

  return {
    tryTake() {
      roll();
      if (used >= limit) return false;
      used++;
      return true;
    },
    remaining() {
      roll();
      return Math.max(0, limit - used);
    },
  };
}

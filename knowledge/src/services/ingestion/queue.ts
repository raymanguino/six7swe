/**
 * A serial, in-process work queue.
 *
 * Ingestion is rare (the owner uploads a handful of files) and each job is
 * dominated by the embedding call, so one at a time is plenty and keeps the
 * embedding provider's rate limits out of the picture. Durability comes from
 * the database instead: a document's status is `pending` until it finishes,
 * and the boot sequence re-queues anything a previous process left behind.
 */
export class SerialQueue<T extends { id: string }> {
  private readonly items: T[] = [];
  /** Ids waiting in `items`. */
  private readonly queued = new Set<string>();
  private current: T | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly worker: (item: T) => Promise<void>,
    private readonly onError: (item: T, error: unknown) => void = () => {},
  ) {}

  /**
   * Adds an item unless one with the same id is already waiting. Returns
   * false when the item was not added (a duplicate, or the queue is stopped).
   */
  enqueue(item: T): boolean {
    if (this.stopped || this.queued.has(item.id)) return false;
    this.queued.add(item.id);
    this.items.push(item);
    this.running ??= this.drain();
    return true;
  }

  /** True while an item with this id is waiting or being worked on. */
  has(id: string): boolean {
    return this.queued.has(id) || this.current?.id === id;
  }

  /**
   * Removes a waiting item. Returns false when nothing with this id was
   * waiting; an item already being worked on is not interrupted.
   */
  cancel(id: string): boolean {
    if (!this.queued.delete(id)) return false;
    const index = this.items.findIndex((item) => item.id === id);
    if (index !== -1) this.items.splice(index, 1);
    return true;
  }

  /** Resolves once the queue is empty. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * Stops taking work: drops the items that have not started and waits for
   * the running one. Returns how many were dropped. The caller owns
   * durability: for ingestion, a dropped document is still `pending` in the
   * database and is picked up again on the next boot.
   */
  async stop(): Promise<number> {
    this.stopped = true;
    const dropped = this.items.splice(0);
    this.queued.clear();
    await this.idle();
    return dropped.length;
  }

  private async drain(): Promise<void> {
    // Yield once before touching any item. `enqueue` assigns `running` only
    // after this call returns its promise; if a worker threw synchronously
    // and the loop finished inside this call, the `finally` below would clear
    // `running` first and `enqueue` would then store a settled promise
    // forever, so nothing enqueued later would run.
    await Promise.resolve();
    try {
      for (let item = this.items.shift(); item; item = this.items.shift()) {
        this.queued.delete(item.id);
        this.current = item;
        try {
          await this.worker(item);
        } catch (error) {
          try {
            this.onError(item, error);
          } catch {
            // A failing error handler must not stop the queue.
          }
        } finally {
          this.current = null;
        }
      }
    } finally {
      // Cleared in the same synchronous step that sees the queue empty, so an
      // `enqueue` from any later microtask starts a new drain instead of
      // assuming this one will pick its item up.
      this.running = null;
    }
  }
}

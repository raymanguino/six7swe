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
  private readonly queued = new Set<string>();
  private running: Promise<void> | null = null;

  constructor(
    private readonly worker: (item: T) => Promise<void>,
    private readonly onError: (item: T, error: unknown) => void = () => {},
  ) {}

  /** Adds an item unless one with the same id is already waiting. */
  enqueue(item: T): void {
    if (this.queued.has(item.id)) return;
    this.queued.add(item.id);
    this.items.push(item);
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
  }

  /** Resolves once the queue is empty. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  get size(): number {
    return this.items.length;
  }

  private async drain(): Promise<void> {
    for (let item = this.items.shift(); item; item = this.items.shift()) {
      this.queued.delete(item.id);
      try {
        await this.worker(item);
      } catch (error) {
        this.onError(item, error);
      }
    }
  }
}

/** A failed call to an embedding provider. */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly details: {
      /** The provider's HTTP status, when it answered. */
      status?: number;
      /** How long the provider asked us to wait (Retry-After), in milliseconds. */
      retryAfterMs?: number;
    } = {},
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }

  get status(): number | undefined {
    return this.details.status;
  }
}

/**
 * A failed call to an embedding provider. Every failure of the
 * OpenAI-compatible embedder, including transport errors and timeouts, is one of these, so
 * the retry policy only has to read `retryable`.
 */
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
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EmbeddingError';
  }

  get status(): number | undefined {
    return this.details.status;
  }
}

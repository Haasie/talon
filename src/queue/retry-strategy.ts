/**
 * Retry strategy — exponential backoff with jitter.
 *
 * Provides a deterministic-but-randomised backoff calculation suitable for
 * distributed retry loops. The jitter prevents thundering-herd behaviour when
 * multiple workers retry at the same time after a shared downstream failure.
 */

/**
 * Calculates the delay before the next retry attempt.
 *
 * Formula: `min(maxMs, baseMs * 2^attempt) + jitter`
 * where jitter is a uniform random value in [0, 0.25 * delay].
 *
 * @param attempt - Zero-based attempt index (0 = first retry after first failure).
 * @param baseMs  - Base delay in milliseconds (e.g. 1000 for 1 second).
 * @param maxMs   - Upper cap on the delay before jitter is added (e.g. 60_000).
 * @returns Milliseconds to wait before the next attempt.
 *
 * @example
 * // attempt=0 → ~1000 ms, attempt=1 → ~2000 ms, attempt=2 → ~4000 ms
 * calculateBackoff(0, 1000, 60_000);
 */
export function calculateBackoff(attempt: number, baseMs: number, maxMs: number): number {
  // Exponential component, capped at maxMs.
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt));

  // Jitter: up to 25% of the capped exponential component.
  const jitter = Math.random() * 0.25 * exponential;

  return Math.round(exponential + jitter);
}

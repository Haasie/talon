/**
 * Result type utilities built on top of neverthrow.
 *
 * Re-exports the neverthrow primitives so that the rest of the codebase only
 * needs to import from this module, giving us a single place to swap
 * implementations in the future.
 */

export { ok, err, Ok, Err, Result, ResultAsync } from 'neverthrow';

import { ok, err, ResultAsync } from 'neverthrow';
import type { Result } from 'neverthrow';
import type { TalonError } from '../errors/error-types.js';

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Returns an `Ok<void>` result — useful for operations that succeed with no
 * meaningful return value.
 */
export function okVoid(): Result<void, never> {
  return ok(undefined as void);
}

/**
 * Wraps a TalonError instance in an `Err` result.
 * Mirrors `err()` but constrains the error to TalonError subclasses.
 */
export function errFromError<E extends TalonError>(error: E): Result<never, E> {
  return err(error);
}

/**
 * Wraps a Promise in a ResultAsync, mapping any thrown value through
 * `errorMapper` so the error type stays within the TalonError hierarchy.
 *
 * @param promise      The async operation to wrap.
 * @param errorMapper  Converts the caught unknown value to a TalonError subclass.
 */
export function resultFromPromise<T, E extends TalonError>(
  promise: Promise<T>,
  errorMapper: (e: unknown) => E,
): ResultAsync<T, E> {
  return ResultAsync.fromPromise(promise, errorMapper);
}

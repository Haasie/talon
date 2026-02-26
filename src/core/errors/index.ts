/**
 * Application error types and Result utilities.
 *
 * Uses neverthrow Result<T, E> for expected errors throughout the daemon.
 * Defines a tagged union of domain error types so call sites can pattern-match
 * on failure reasons without catching exceptions.
 */

export {};

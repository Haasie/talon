/**
 * Shared primitive types used across all Talon subsystems.
 *
 * Branded types prevent accidental mixing of string-based identifiers.
 * All helpers are pure functions with no side effects.
 */

import { v4 as uuidv4 } from 'uuid';

/** Branded type utility — attaches a phantom type tag to a primitive. */
type Brand<T, B> = T & { readonly __brand: B };

/** A UUID v4 string, branded to prevent mixing with arbitrary strings. */
export type UUID = Brand<string, 'UUID'>;

/** Unix epoch milliseconds. */
export type Timestamp = number;

// ---------------------------------------------------------------------------
// UUID helpers
// ---------------------------------------------------------------------------

/**
 * Generate a new random UUID v4.
 */
export function createUuid(): UUID {
  return uuidv4() as UUID;
}

/**
 * Type guard: returns true when the given string is a valid UUID.
 * Accepts lowercase UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
export function isUuid(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/**
 * Returns the current time as Unix epoch milliseconds.
 */
export function now(): Timestamp {
  return Date.now();
}

/**
 * Converts a Timestamp to an ISO 8601 string (UTC).
 */
export function toIsoString(ts: Timestamp): string {
  return new Date(ts).toISOString();
}

/**
 * Parses an ISO 8601 string to a Timestamp (Unix epoch milliseconds).
 * Throws a RangeError if the string is not a valid date.
 */
export function fromIsoString(iso: string): Timestamp {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) {
    throw new RangeError(`Invalid ISO 8601 date string: "${iso}"`);
  }
  return ts;
}

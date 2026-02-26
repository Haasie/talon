/**
 * Shared domain types.
 *
 * Branded primitive types (UUID, Timestamp) and Result utilities used across
 * all Talon subsystems. Keep this module free of heavyweight runtime
 * dependencies — only lightweight helpers.
 */

export type { UUID, Timestamp } from './common.js';
export { createUuid, isUuid, now, toIsoString, fromIsoString } from './common.js';

export type { Result, Ok, Err, ResultAsync } from './result.js';
export { ok, err, okVoid, errFromError, resultFromPromise } from './result.js';

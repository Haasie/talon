/**
 * Cron expression evaluation utilities.
 *
 * Thin wrapper around `cron-parser` that returns Result types consistent
 * with the rest of the Talon error-handling conventions.
 */

import cronParser from 'cron-parser';
const { parseExpression } = cronParser;
import { ok, err, type Result } from 'neverthrow';
import { ScheduleError } from '../core/errors/index.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes the next time a cron expression will fire.
 *
 * @param expression - Standard 5-field cron expression (e.g. "0 9 * * *").
 * @param after      - Point in time to compute "next" relative to. Defaults to `new Date()`.
 * @param options    - Optional settings. `tz` sets the timezone for evaluation (default: system local).
 * @returns Ok(epochMs) on success, or a ScheduleError if the expression is invalid.
 */
export function getNextCronTime(
  expression: string,
  after?: Date,
  options?: { tz?: string },
): Result<number, ScheduleError> {
  try {
    const interval = parseExpression(expression, {
      currentDate: after ?? new Date(),
      tz: options?.tz,
    });
    return ok(interval.next().getTime());
  } catch (cause) {
    return err(
      new ScheduleError(
        `Invalid cron expression "${expression}": ${cause instanceof Error ? cause.message : String(cause)}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }
}

/**
 * Returns true if `expression` is a valid 5-field cron expression.
 *
 * @param expression - The expression to validate.
 */
export function isValidCronExpression(expression: string): boolean {
  try {
    parseExpression(expression, { utc: true });
    return true;
  } catch {
    return false;
  }
}

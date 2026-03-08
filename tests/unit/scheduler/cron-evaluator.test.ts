import { describe, it, expect } from 'vitest';
import { getNextCronTime, isValidCronExpression } from '../../../src/scheduler/cron-evaluator.js';

// ---------------------------------------------------------------------------
// isValidCronExpression
// ---------------------------------------------------------------------------

describe('isValidCronExpression', () => {
  it('returns true for a valid every-minute expression', () => {
    expect(isValidCronExpression('* * * * *')).toBe(true);
  });

  it('returns true for a valid every-5-minutes expression', () => {
    expect(isValidCronExpression('*/5 * * * *')).toBe(true);
  });

  it('returns true for a valid daily-at-9am expression', () => {
    expect(isValidCronExpression('0 9 * * *')).toBe(true);
  });

  it('returns true for a valid monthly expression', () => {
    expect(isValidCronExpression('0 0 1 * *')).toBe(true);
  });

  it('returns true for a complex expression with day-of-week', () => {
    expect(isValidCronExpression('30 8 * * 1-5')).toBe(true);
  });

  it('returns true for an empty string (cron-parser v4 treats it as wildcard)', () => {
    // cron-parser v4 accepts an empty string as equivalent to "* * * * *"
    expect(isValidCronExpression('')).toBe(true);
  });

  it('returns false for a random non-cron string', () => {
    expect(isValidCronExpression('not-a-cron')).toBe(false);
  });

  it('returns false for an expression with too many fields', () => {
    expect(isValidCronExpression('* * * * * * *')).toBe(false);
  });

  it('returns false for an expression with an out-of-range minute', () => {
    expect(isValidCronExpression('60 * * * *')).toBe(false);
  });

  it('returns false for an expression with an out-of-range hour', () => {
    expect(isValidCronExpression('* 25 * * *')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getNextCronTime
// ---------------------------------------------------------------------------

describe('getNextCronTime', () => {
  it('returns Ok with a future timestamp for a valid expression', () => {
    const before = Date.now();
    const result = getNextCronTime('* * * * *');
    expect(result.isOk()).toBe(true);
    const ms = result._unsafeUnwrap();
    expect(ms).toBeGreaterThan(before);
  });

  it('returns the next occurrence strictly after the given `after` date', () => {
    // Pin "now" to a known time: 2026-01-01 08:00:00 UTC
    const after = new Date('2026-01-01T08:00:00.000Z');
    // "0 9 * * *" fires daily at 09:00 UTC
    const result = getNextCronTime('0 9 * * *', after, { tz: 'UTC' });
    expect(result.isOk()).toBe(true);
    const next = new Date(result._unsafeUnwrap());
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
    // Should be on the same day since 08:00 < 09:00
    expect(next.getTime()).toBeGreaterThan(after.getTime());
  });

  it('advances to the next day when the daily time has already passed', () => {
    // Pin "now" to 10:00 UTC — the 09:00 slot has already passed today
    const after = new Date('2026-01-01T10:00:00.000Z');
    const result = getNextCronTime('0 9 * * *', after, { tz: 'UTC' });
    expect(result.isOk()).toBe(true);
    const next = new Date(result._unsafeUnwrap());
    // Should be 2026-01-02T09:00:00 UTC
    expect(next.getUTCDate()).toBe(2);
    expect(next.getUTCHours()).toBe(9);
  });

  it('returns a timestamp consistent with every-5-minutes interval', () => {
    // Pin to the start of an hour so we can predict the next slot
    const after = new Date('2026-01-01T12:00:00.000Z');
    const result = getNextCronTime('*/5 * * * *', after, { tz: 'UTC' });
    expect(result.isOk()).toBe(true);
    const next = new Date(result._unsafeUnwrap());
    // The next slot after 12:00 is 12:05
    expect(next.getUTCHours()).toBe(12);
    expect(next.getUTCMinutes()).toBe(5);
  });

  it('returns Ok for an empty expression (cron-parser treats it as wildcard)', () => {
    // cron-parser v4 accepts empty string as "* * * * *"; it is not an error.
    const result = getNextCronTime('');
    expect(result.isOk()).toBe(true);
  });

  it('returns Err for a non-cron string', () => {
    const result = getNextCronTime('daily at noon');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Invalid cron expression');
  });

  it('returns Err for an out-of-range minute value', () => {
    const result = getNextCronTime('99 * * * *');
    expect(result.isErr()).toBe(true);
  });

  it('error code is SCHEDULE_ERROR', () => {
    const result = getNextCronTime('bad');
    expect(result._unsafeUnwrapErr().code).toBe('SCHEDULE_ERROR');
  });
});

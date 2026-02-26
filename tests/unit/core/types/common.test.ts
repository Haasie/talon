import { describe, it, expect, vi } from 'vitest';
import {
  createUuid,
  isUuid,
  now,
  toIsoString,
  fromIsoString,
  type UUID,
  type Timestamp,
} from '../../../../src/core/types/common.js';

describe('UUID helpers', () => {
  describe('createUuid()', () => {
    it('returns a string', () => {
      expect(typeof createUuid()).toBe('string');
    });

    it('returns a value that passes isUuid()', () => {
      const id = createUuid();
      expect(isUuid(id)).toBe(true);
    });

    it('generates unique values on repeated calls', () => {
      const ids = new Set(Array.from({ length: 20 }, () => createUuid()));
      expect(ids.size).toBe(20);
    });

    it('conforms to UUID v4 format', () => {
      const id = createUuid();
      // UUID v4: version digit is 4, variant nibble is 8, 9, a, or b
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  describe('isUuid()', () => {
    it('returns true for a valid UUID v4', () => {
      // v1 UUID — version digit is 1, not 4
      expect(isUuid('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
      expect(isUuid('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
    });

    it('returns true for a freshly generated UUID', () => {
      expect(isUuid(createUuid())).toBe(true);
    });

    it('returns false for an empty string', () => {
      expect(isUuid('')).toBe(false);
    });

    it('returns false for a plain string', () => {
      expect(isUuid('not-a-uuid')).toBe(false);
    });

    it('returns false for an uppercase UUID', () => {
      // Our regex only accepts lowercase hex
      expect(isUuid('F47AC10B-58CC-4372-A567-0E02B2C3D479')).toBe(false);
    });

    it('acts as a type guard (compile-time)', () => {
      const value: string = createUuid();
      if (isUuid(value)) {
        // TypeScript should narrow to UUID here — assign to typed variable
        const _id: UUID = value;
        expect(_id).toBeTruthy();
      }
    });
  });
});

describe('Timestamp helpers', () => {
  describe('now()', () => {
    it('returns a number', () => {
      expect(typeof now()).toBe('number');
    });

    it('returns a positive integer (milliseconds since epoch)', () => {
      const ts = now();
      expect(ts).toBeGreaterThan(0);
      expect(Number.isInteger(ts)).toBe(true);
    });

    it('advances over time', async () => {
      const t1 = now();
      await new Promise((r) => setTimeout(r, 5));
      const t2 = now();
      expect(t2).toBeGreaterThan(t1);
    });

    it('is consistent with Date.now()', () => {
      vi.useFakeTimers();
      const fakeMs = 1_700_000_000_000;
      vi.setSystemTime(fakeMs);
      expect(now()).toBe(fakeMs);
      vi.useRealTimers();
    });
  });

  describe('toIsoString()', () => {
    it('returns a string', () => {
      expect(typeof toIsoString(now())).toBe('string');
    });

    it('produces a valid ISO 8601 UTC string', () => {
      const iso = toIsoString(0);
      expect(iso).toBe('1970-01-01T00:00:00.000Z');
    });

    it('round-trips through fromIsoString()', () => {
      const ts: Timestamp = 1_700_000_000_000;
      expect(fromIsoString(toIsoString(ts))).toBe(ts);
    });
  });

  describe('fromIsoString()', () => {
    it('parses a known ISO date correctly', () => {
      expect(fromIsoString('1970-01-01T00:00:00.000Z')).toBe(0);
    });

    it('parses a recent timestamp', () => {
      const ts = 1_700_000_000_000;
      expect(fromIsoString('2023-11-14T22:13:20.000Z')).toBe(ts);
    });

    it('throws RangeError for an invalid string', () => {
      expect(() => fromIsoString('not-a-date')).toThrow(RangeError);
    });

    it('throws RangeError for an empty string', () => {
      expect(() => fromIsoString('')).toThrow(RangeError);
    });
  });
});

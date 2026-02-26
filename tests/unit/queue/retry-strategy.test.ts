import { describe, it, expect } from 'vitest';
import { calculateBackoff } from '../../../src/queue/retry-strategy.js';

describe('calculateBackoff', () => {
  describe('exponential growth', () => {
    it('grows exponentially with the attempt number', () => {
      const base = 1000;
      const max = 60_000;

      // Each attempt should produce a value >= base * 2^attempt
      // (before the cap is applied). We check the floor.
      const delay0 = calculateBackoff(0, base, max);
      const delay1 = calculateBackoff(1, base, max);
      const delay2 = calculateBackoff(2, base, max);

      // Minimum values (no jitter): 1000, 2000, 4000
      expect(delay0).toBeGreaterThanOrEqual(1000);
      expect(delay1).toBeGreaterThanOrEqual(2000);
      expect(delay2).toBeGreaterThanOrEqual(4000);
    });

    it('returns a value >= baseMs for attempt 0', () => {
      const result = calculateBackoff(0, 500, 60_000);
      expect(result).toBeGreaterThanOrEqual(500);
    });

    it('increases from attempt 0 to attempt 1', () => {
      // Run multiple times to reduce flakiness from jitter.
      let increase = 0;
      for (let i = 0; i < 20; i++) {
        const d0 = calculateBackoff(0, 100, 60_000);
        const d1 = calculateBackoff(1, 100, 60_000);
        if (d1 >= d0) increase++;
      }
      // Should hold at least 80% of the time given max 25% jitter overlap.
      expect(increase).toBeGreaterThanOrEqual(16);
    });
  });

  describe('max cap', () => {
    it('caps the exponential component at maxMs', () => {
      const max = 5000;
      // attempt=10 → base * 2^10 = 1000 * 1024 >> 5000, so should be capped
      const delay = calculateBackoff(10, 1000, max);
      // Maximum possible value with 25% jitter: 5000 * 1.25 = 6250
      expect(delay).toBeLessThanOrEqual(Math.ceil(max * 1.25) + 1);
    });

    it('never exceeds maxMs * 1.25 (max jitter boundary)', () => {
      const max = 2000;
      for (let attempt = 0; attempt < 20; attempt++) {
        const delay = calculateBackoff(attempt, 100, max);
        expect(delay).toBeLessThanOrEqual(Math.ceil(max * 1.25) + 1);
      }
    });

    it('respects a small maxMs even for large attempt counts', () => {
      const max = 100;
      const delay = calculateBackoff(100, 1000, max);
      // 100 * 1.25 = 125 max
      expect(delay).toBeLessThanOrEqual(Math.ceil(max * 1.25) + 1);
    });
  });

  describe('jitter range', () => {
    it('jitter is at most 25% of the capped exponential delay', () => {
      const base = 1000;
      const max = 60_000;
      const attempt = 0;
      const exponential = Math.min(max, base * Math.pow(2, attempt)); // 1000

      // Run many times; every result should be in [exponential, exponential * 1.25]
      for (let i = 0; i < 100; i++) {
        const delay = calculateBackoff(attempt, base, max);
        expect(delay).toBeGreaterThanOrEqual(exponential);
        expect(delay).toBeLessThanOrEqual(Math.ceil(exponential * 1.25) + 1);
      }
    });

    it('produces non-deterministic results across calls (jitter present)', () => {
      // Run 50 iterations and check that we see at least 2 distinct values.
      const results = new Set<number>();
      for (let i = 0; i < 50; i++) {
        results.add(calculateBackoff(0, 1000, 60_000));
      }
      expect(results.size).toBeGreaterThan(1);
    });
  });

  describe('edge cases', () => {
    it('handles attempt=0 (first retry)', () => {
      const delay = calculateBackoff(0, 1000, 60_000);
      expect(typeof delay).toBe('number');
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
    });

    it('returns an integer (rounded)', () => {
      for (let i = 0; i < 20; i++) {
        const delay = calculateBackoff(i % 5, 1000, 60_000);
        expect(Number.isInteger(delay)).toBe(true);
      }
    });

    it('handles baseMs=0 gracefully', () => {
      const delay = calculateBackoff(3, 0, 60_000);
      expect(delay).toBe(0);
    });
  });
});

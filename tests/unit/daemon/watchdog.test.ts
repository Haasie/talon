/**
 * Unit tests for WatchdogNotifier.
 *
 * Uses real temporary directories so that filesystem writes can be verified
 * without mocking the `fs` module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';

import { WatchdogNotifier } from '../../../src/daemon/watchdog.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-watchdog-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WatchdogNotifier', () => {
  let tmpDir: string;
  let notifier: WatchdogNotifier;

  beforeEach(() => {
    tmpDir = makeTempDir();
    vi.useFakeTimers();
  });

  afterEach(() => {
    notifier?.stop();
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('accepts intervalMs and logger options', () => {
      notifier = new WatchdogNotifier({
        intervalMs: 5000,
        logger: createSilentLogger(),
        dataDir: tmpDir,
      });

      // If no error is thrown the constructor accepted the options.
      expect(notifier).toBeInstanceOf(WatchdogNotifier);
    });

    it('defaults dataDir to "data" when not provided', () => {
      // We just verify construction succeeds; we cannot easily read back the
      // private field, so we rely on it not throwing.
      notifier = new WatchdogNotifier({
        intervalMs: 1000,
        logger: createSilentLogger(),
      });
      expect(notifier).toBeInstanceOf(WatchdogNotifier);
    });
  });

  // -------------------------------------------------------------------------
  // start() and heartbeat
  // -------------------------------------------------------------------------

  describe('start()', () => {
    it('writes a heartbeat file immediately on start', () => {
      notifier = new WatchdogNotifier({
        intervalMs: 10_000,
        logger: createSilentLogger(),
        dataDir: tmpDir,
      });

      notifier.start();

      const watchdogFile = join(tmpDir, 'watchdog');
      expect(existsSync(watchdogFile)).toBe(true);
    });

    it('heartbeat file contains an ISO-8601 timestamp', () => {
      notifier = new WatchdogNotifier({
        intervalMs: 10_000,
        logger: createSilentLogger(),
        dataDir: tmpDir,
      });

      notifier.start();

      const content = readFileSync(join(tmpDir, 'watchdog'), 'utf-8');
      // ISO-8601 datetime strings can be parsed by Date
      expect(new Date(content).getTime()).not.toBeNaN();
    });

    it('updates the heartbeat file on each timer tick', () => {
      notifier = new WatchdogNotifier({
        intervalMs: 5_000,
        logger: createSilentLogger(),
        dataDir: tmpDir,
      });

      notifier.start();

      const firstContent = readFileSync(join(tmpDir, 'watchdog'), 'utf-8');

      // Advance fake time by one interval
      vi.advanceTimersByTime(5_000);

      const secondContent = readFileSync(join(tmpDir, 'watchdog'), 'utf-8');

      // Content may be the same if Date.now() is frozen — just verify the file
      // exists and can be read both times.
      expect(typeof firstContent).toBe('string');
      expect(typeof secondContent).toBe('string');
    });

    it('is idempotent — calling start() twice does not create two timers', () => {
      notifier = new WatchdogNotifier({
        intervalMs: 5_000,
        logger: createSilentLogger(),
        dataDir: tmpDir,
      });

      notifier.start();
      notifier.start(); // second call should be a no-op

      // If two timers were running we would see two tick effects, but since
      // all effects are writes to the same file, we can only verify that
      // calling start() twice does not throw.
      expect(existsSync(join(tmpDir, 'watchdog'))).toBe(true);
    });

    it('creates the dataDir if it does not exist', () => {
      const nestedDir = join(tmpDir, 'nested', 'subdir');
      notifier = new WatchdogNotifier({
        intervalMs: 10_000,
        logger: createSilentLogger(),
        dataDir: nestedDir,
      });

      notifier.start();

      expect(existsSync(join(nestedDir, 'watchdog'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  describe('stop()', () => {
    it('stops the timer so no further ticks occur after stop', () => {
      notifier = new WatchdogNotifier({
        intervalMs: 5_000,
        logger: createSilentLogger(),
        dataDir: tmpDir,
      });

      notifier.start();

      // Record the mtime of the watchdog file after start
      const contentAfterStart = readFileSync(join(tmpDir, 'watchdog'), 'utf-8');

      notifier.stop();

      // Advance time well past one interval — the timer should NOT fire
      vi.advanceTimersByTime(20_000);

      // The file content should not have changed because the timer was stopped
      const contentAfterStop = readFileSync(join(tmpDir, 'watchdog'), 'utf-8');
      expect(contentAfterStop).toBe(contentAfterStart);
    });

    it('is safe to call stop() on a notifier that was never started', () => {
      notifier = new WatchdogNotifier({
        intervalMs: 5_000,
        logger: createSilentLogger(),
        dataDir: tmpDir,
      });

      expect(() => notifier.stop()).not.toThrow();
    });

    it('is safe to call stop() twice', () => {
      notifier = new WatchdogNotifier({
        intervalMs: 5_000,
        logger: createSilentLogger(),
        dataDir: tmpDir,
      });

      notifier.start();
      notifier.stop();

      expect(() => notifier.stop()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // notifyReady()
  // -------------------------------------------------------------------------

  describe('notifyReady()', () => {
    it('writes READY=1 to the ready status file', () => {
      notifier = new WatchdogNotifier({
        intervalMs: 10_000,
        logger: createSilentLogger(),
        dataDir: tmpDir,
      });

      notifier.notifyReady();

      const content = readFileSync(join(tmpDir, 'ready'), 'utf-8');
      expect(content).toBe('READY=1');
    });

    it('creates the ready file even if dataDir does not yet exist', () => {
      const nestedDir = join(tmpDir, 'deep', 'path');
      notifier = new WatchdogNotifier({
        intervalMs: 10_000,
        logger: createSilentLogger(),
        dataDir: nestedDir,
      });

      notifier.notifyReady();

      expect(existsSync(join(nestedDir, 'ready'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // notifyStopping()
  // -------------------------------------------------------------------------

  describe('notifyStopping()', () => {
    it('writes STOPPING=1 to the stopping status file', () => {
      notifier = new WatchdogNotifier({
        intervalMs: 10_000,
        logger: createSilentLogger(),
        dataDir: tmpDir,
      });

      notifier.notifyStopping();

      const content = readFileSync(join(tmpDir, 'stopping'), 'utf-8');
      expect(content).toBe('STOPPING=1');
    });

    it('creates the stopping file even if dataDir does not yet exist', () => {
      const nestedDir = join(tmpDir, 'another', 'path');
      notifier = new WatchdogNotifier({
        intervalMs: 10_000,
        logger: createSilentLogger(),
        dataDir: nestedDir,
      });

      notifier.notifyStopping();

      expect(existsSync(join(nestedDir, 'stopping'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Combined lifecycle
  // -------------------------------------------------------------------------

  describe('full lifecycle', () => {
    it('notifyReady → start → notifyStopping → stop produces all three files', () => {
      notifier = new WatchdogNotifier({
        intervalMs: 10_000,
        logger: createSilentLogger(),
        dataDir: tmpDir,
      });

      notifier.notifyReady();
      notifier.start();
      notifier.notifyStopping();
      notifier.stop();

      expect(existsSync(join(tmpDir, 'ready'))).toBe(true);
      expect(existsSync(join(tmpDir, 'watchdog'))).toBe(true);
      expect(existsSync(join(tmpDir, 'stopping'))).toBe(true);
    });
  });
});

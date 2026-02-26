/**
 * Unit tests for SessionTracker.
 *
 * Tests cover all CRUD operations on the in-memory session map:
 *  - getSessionId (hit / miss)
 *  - setSessionId (insert / overwrite)
 *  - clearSession (existing / non-existent)
 *  - clearAll
 *  - size
 *  - hasSession
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTracker } from '../../../src/sandbox/session-tracker.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('SessionTracker', () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker();
  });

  // -------------------------------------------------------------------------
  // getSessionId
  // -------------------------------------------------------------------------

  describe('getSessionId()', () => {
    it('returns undefined for a thread with no session', () => {
      expect(tracker.getSessionId('thread-1')).toBeUndefined();
    });

    it('returns the session ID after it has been set', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      expect(tracker.getSessionId('thread-1')).toBe('ses-abc');
    });

    it('returns the updated session ID after it is overwritten', () => {
      tracker.setSessionId('thread-1', 'ses-old');
      tracker.setSessionId('thread-1', 'ses-new');
      expect(tracker.getSessionId('thread-1')).toBe('ses-new');
    });

    it('returns undefined after the session has been cleared', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      tracker.clearSession('thread-1');
      expect(tracker.getSessionId('thread-1')).toBeUndefined();
    });

    it('returns undefined for a different thread', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      expect(tracker.getSessionId('thread-2')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // setSessionId
  // -------------------------------------------------------------------------

  describe('setSessionId()', () => {
    it('stores the session ID for a new thread', () => {
      tracker.setSessionId('thread-new', 'ses-xyz');
      expect(tracker.getSessionId('thread-new')).toBe('ses-xyz');
    });

    it('overwrites the previous session ID for the same thread', () => {
      tracker.setSessionId('thread-1', 'ses-v1');
      tracker.setSessionId('thread-1', 'ses-v2');
      expect(tracker.getSessionId('thread-1')).toBe('ses-v2');
    });

    it('supports multiple threads independently', () => {
      tracker.setSessionId('t-1', 'ses-t1');
      tracker.setSessionId('t-2', 'ses-t2');
      tracker.setSessionId('t-3', 'ses-t3');
      expect(tracker.getSessionId('t-1')).toBe('ses-t1');
      expect(tracker.getSessionId('t-2')).toBe('ses-t2');
      expect(tracker.getSessionId('t-3')).toBe('ses-t3');
    });
  });

  // -------------------------------------------------------------------------
  // clearSession
  // -------------------------------------------------------------------------

  describe('clearSession()', () => {
    it('removes the session ID for the specified thread', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      tracker.clearSession('thread-1');
      expect(tracker.getSessionId('thread-1')).toBeUndefined();
    });

    it('does not affect other threads', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      tracker.setSessionId('thread-2', 'ses-def');
      tracker.clearSession('thread-1');
      expect(tracker.getSessionId('thread-2')).toBe('ses-def');
    });

    it('is a no-op for a thread with no session', () => {
      // Should not throw.
      expect(() => tracker.clearSession('nonexistent-thread')).not.toThrow();
    });

    it('reduces size by 1 when clearing an existing session', () => {
      tracker.setSessionId('thread-1', 'ses-1');
      tracker.setSessionId('thread-2', 'ses-2');
      tracker.clearSession('thread-1');
      expect(tracker.size()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // clearAll
  // -------------------------------------------------------------------------

  describe('clearAll()', () => {
    it('removes all stored sessions', () => {
      tracker.setSessionId('t-1', 'ses-1');
      tracker.setSessionId('t-2', 'ses-2');
      tracker.setSessionId('t-3', 'ses-3');
      tracker.clearAll();
      expect(tracker.getSessionId('t-1')).toBeUndefined();
      expect(tracker.getSessionId('t-2')).toBeUndefined();
      expect(tracker.getSessionId('t-3')).toBeUndefined();
    });

    it('reduces size to 0', () => {
      tracker.setSessionId('t-1', 'ses-1');
      tracker.setSessionId('t-2', 'ses-2');
      tracker.clearAll();
      expect(tracker.size()).toBe(0);
    });

    it('is a no-op on an empty tracker', () => {
      expect(() => tracker.clearAll()).not.toThrow();
      expect(tracker.size()).toBe(0);
    });

    it('allows new sessions to be added after clearAll', () => {
      tracker.setSessionId('t-1', 'ses-old');
      tracker.clearAll();
      tracker.setSessionId('t-1', 'ses-new');
      expect(tracker.getSessionId('t-1')).toBe('ses-new');
    });
  });

  // -------------------------------------------------------------------------
  // size
  // -------------------------------------------------------------------------

  describe('size()', () => {
    it('returns 0 for a new tracker', () => {
      expect(tracker.size()).toBe(0);
    });

    it('increases by 1 for each unique thread', () => {
      tracker.setSessionId('t-1', 'ses-1');
      expect(tracker.size()).toBe(1);
      tracker.setSessionId('t-2', 'ses-2');
      expect(tracker.size()).toBe(2);
    });

    it('does not increase when overwriting an existing thread', () => {
      tracker.setSessionId('t-1', 'ses-v1');
      tracker.setSessionId('t-1', 'ses-v2');
      expect(tracker.size()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // hasSession
  // -------------------------------------------------------------------------

  describe('hasSession()', () => {
    it('returns false for an unknown thread', () => {
      expect(tracker.hasSession('unknown')).toBe(false);
    });

    it('returns true after a session is set', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      expect(tracker.hasSession('thread-1')).toBe(true);
    });

    it('returns false after the session is cleared', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      tracker.clearSession('thread-1');
      expect(tracker.hasSession('thread-1')).toBe(false);
    });

    it('returns false for all threads after clearAll', () => {
      tracker.setSessionId('t-1', 'ses-1');
      tracker.setSessionId('t-2', 'ses-2');
      tracker.clearAll();
      expect(tracker.hasSession('t-1')).toBe(false);
      expect(tracker.hasSession('t-2')).toBe(false);
    });
  });
});

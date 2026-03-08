import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ok, err } from 'neverthrow';
import { QueueError } from '../../../src/core/errors/index.js';
import { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import { Scheduler } from '../../../src/scheduler/scheduler.js';
import type { ScheduleConfig } from '../../../src/scheduler/schedule-types.js';
import type { QueueManager } from '../../../src/queue/queue-manager.js';
import type { QueueItem } from '../../../src/queue/queue-types.js';
import { QueueItemStatus } from '../../../src/queue/queue-types.js';
import { createTestDb, createTestLogger, seedPersona, seedThread, seedDueSchedule, uuid } from './helpers.js';

// ---------------------------------------------------------------------------
// Minimal QueueManager stub
// ---------------------------------------------------------------------------

function makeQueueStub(
  enqueueImpl: (threadId: string, type: string, payload: Record<string, unknown>) => ReturnType<QueueManager['enqueue']> = () =>
    ok(makeQueueItem()),
): QueueManager {
  return {
    enqueue: vi.fn(enqueueImpl),
    startProcessing: vi.fn(),
    stopProcessing: vi.fn(),
    stats: vi.fn(),
  } as unknown as QueueManager;
}

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: uuid(),
    threadId: uuid(),
    type: 'schedule',
    status: QueueItemStatus.Pending,
    attempts: 0,
    maxAttempts: 3,
    payload: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAST_CONFIG: ScheduleConfig = { tickIntervalMs: 50 };

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scheduler', () => {
  let db: Database.Database;
  let scheduleRepo: ScheduleRepository;
  let personaId: string;
  let threadId: string;
  let scheduler: Scheduler;
  let queueStub: QueueManager;

  beforeEach(() => {
    db = createTestDb();
    scheduleRepo = new ScheduleRepository(db);
    personaId = seedPersona(db);
    threadId = seedThread(db);
    queueStub = makeQueueStub();
    scheduler = new Scheduler(scheduleRepo, queueStub, FAST_CONFIG, createTestLogger());
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
  });

  // -------------------------------------------------------------------------
  // Basic lifecycle
  // -------------------------------------------------------------------------

  describe('start / stop', () => {
    it('starts without error when no schedules are due', async () => {
      scheduler.start();
      await wait(120);
      scheduler.stop();
      // No assertion needed — just must not throw
    });

    it('logs a warning and returns early if start() called twice', () => {
      scheduler.start();
      // Second call should not throw
      scheduler.start();
      scheduler.stop();
    });

    it('stop() is safe to call before start()', () => {
      // Should not throw
      scheduler.stop();
    });

    it('does not process new schedules after stop()', async () => {
      // Seed a schedule, start, let one tick run, then stop, then seed another
      // and confirm only the first was enqueued.
      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });
      scheduler.start();
      await wait(120);
      scheduler.stop();

      const callsAfterStop = (queueStub.enqueue as ReturnType<typeof vi.fn>).mock.calls.length;

      // Seed another due schedule after stop
      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });
      await wait(200);

      const callsLater = (queueStub.enqueue as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsLater).toBe(callsAfterStop);
    });
  });

  // -------------------------------------------------------------------------
  // one_shot schedule
  // -------------------------------------------------------------------------

  describe('one_shot schedule', () => {
    it('enqueues a due one_shot schedule', async () => {
      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });

    it('disables the schedule after firing', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db.prepare('SELECT enabled FROM schedules WHERE id = ?').get(scheduleId) as {
        enabled: number;
      };
      expect(row.enabled).toBe(0);
    });

    it('does not fire the same one_shot schedule twice', async () => {
      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });

      scheduler.start();
      // Wait for several tick intervals
      await wait(300);
      scheduler.stop();

      // Should have fired exactly once
      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });

    it('passes the parsed payload to enqueue', async () => {
      const payload = { message: 'hello', num: 42 };
      seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: JSON.stringify(payload),
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      // Scheduler injects personaId and content from schedule row.
      expect(queueStub.enqueue).toHaveBeenCalledWith(threadId, 'schedule', {
        ...payload,
        personaId,
        content: '',
      });
    });

    it('maps schedule prompt to content for AgentRunner compatibility', async () => {
      const payload = { label: 'Daily', prompt: 'Summarize open issues' };
      seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: JSON.stringify(payload),
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(queueStub.enqueue).toHaveBeenCalledWith(threadId, 'schedule', {
        label: 'Daily',
        prompt: 'Summarize open issues',
        personaId,
        content: 'Summarize open issues',
      });
    });

    it('uses the thread_id of the schedule when enqueuing', async () => {
      const anotherThread = seedThread(db);
      seedDueSchedule(db, personaId, anotherThread, { type: 'one_shot' });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      const calls = (queueStub.enqueue as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toBe(anotherThread);
    });
  });

  // -------------------------------------------------------------------------
  // event schedule
  // -------------------------------------------------------------------------

  describe('event schedule', () => {
    it('enqueues a due event schedule', async () => {
      seedDueSchedule(db, personaId, threadId, {
        type: 'event',
        expression: 'my-event',
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });

    it('disables the event schedule after firing', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'event',
        expression: 'my-event',
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db.prepare('SELECT enabled FROM schedules WHERE id = ?').get(scheduleId) as {
        enabled: number;
      };
      expect(row.enabled).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // interval schedule
  // -------------------------------------------------------------------------

  describe('interval schedule', () => {
    it('enqueues a due interval schedule', async () => {
      // Expression is interval in ms; schedule is already due
      seedDueSchedule(db, personaId, threadId, {
        type: 'interval',
        expression: '10000', // 10 second interval
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });

    it('updates next_run_at after firing an interval schedule', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'interval',
        expression: '60000', // 60s interval
      });

      const before = Date.now();
      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db.prepare('SELECT next_run_at, last_run_at, enabled FROM schedules WHERE id = ?').get(scheduleId) as {
        next_run_at: number;
        last_run_at: number;
        enabled: number;
      };

      // Should be re-enabled with a future next_run_at
      expect(row.enabled).toBe(1);
      expect(row.next_run_at).toBeGreaterThanOrEqual(before + 60000);
      expect(row.last_run_at).toBeGreaterThanOrEqual(before);
    });

    it('does not fire an interval schedule again before its next_run_at', async () => {
      // Set next_run_at far in the future after first run
      seedDueSchedule(db, personaId, threadId, {
        type: 'interval',
        expression: '300000', // 5 minute interval — will not come due again in test window
      });

      scheduler.start();
      // Allow several tick cycles
      await wait(300);
      scheduler.stop();

      // Should fire only once
      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });

    it('disables an interval schedule with an invalid expression', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'interval',
        expression: 'not-a-number',
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db.prepare('SELECT enabled FROM schedules WHERE id = ?').get(scheduleId) as {
        enabled: number;
      };
      // Invalid interval expression — should be disabled
      expect(row.enabled).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // cron schedule
  // -------------------------------------------------------------------------

  describe('cron schedule', () => {
    it('enqueues a due cron schedule', async () => {
      // Use "* * * * *" (every minute). The test seeds it as already due.
      seedDueSchedule(db, personaId, threadId, {
        type: 'cron',
        expression: '* * * * *',
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });

    it('updates next_run_at after firing a cron schedule', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'cron',
        expression: '* * * * *',
      });

      const before = Date.now();
      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db.prepare('SELECT next_run_at, last_run_at, enabled FROM schedules WHERE id = ?').get(scheduleId) as {
        next_run_at: number;
        last_run_at: number;
        enabled: number;
      };

      // Cron schedule should remain enabled and have a future next_run_at
      expect(row.enabled).toBe(1);
      expect(row.next_run_at).toBeGreaterThan(before);
      expect(row.last_run_at).toBeGreaterThanOrEqual(before);
    });

    it('disables a cron schedule with an invalid expression', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'cron',
        expression: 'not-a-cron',
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db.prepare('SELECT enabled FROM schedules WHERE id = ?').get(scheduleId) as {
        enabled: number;
      };
      // Invalid cron expression — should be disabled
      expect(row.enabled).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Null thread_id
  // -------------------------------------------------------------------------

  describe('null thread_id', () => {
    it('skips enqueue for schedules without a thread_id', async () => {
      // Seed a schedule with null thread_id — FK constraint allows it
      db.pragma('foreign_keys = OFF');
      seedDueSchedule(db, personaId, null, { type: 'one_shot' });
      db.pragma('foreign_keys = ON');

      scheduler.start();
      await wait(150);
      scheduler.stop();

      // enqueue should not have been called since there is no thread
      expect(queueStub.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Multiple schedules
  // -------------------------------------------------------------------------

  describe('multiple due schedules', () => {
    it('enqueues all due schedules on a single tick', async () => {
      const thread2 = seedThread(db);
      const thread3 = seedThread(db);

      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });
      seedDueSchedule(db, personaId, thread2, { type: 'one_shot' });
      seedDueSchedule(db, personaId, thread3, { type: 'one_shot' });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(queueStub.enqueue).toHaveBeenCalledTimes(3);
    });

    it('does not enqueue a schedule that is not yet due', async () => {
      // Due schedule
      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });
      // Future schedule — next_run_at is 60 seconds from now
      seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        next_run_at: Date.now() + 60_000,
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      // Only the first (due) schedule should be enqueued
      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('continues processing other schedules when enqueue fails for one', async () => {
      const thread2 = seedThread(db);

      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });
      seedDueSchedule(db, personaId, thread2, { type: 'one_shot' });

      const thread2Calls: string[] = [];
      const failingStub = makeQueueStub((tId) => {
        if (tId === threadId) {
          return err(new QueueError('enqueue failed'));
        }
        thread2Calls.push(tId);
        return ok(makeQueueItem({ threadId: tId }));
      });

      scheduler = new Scheduler(scheduleRepo, failingStub, FAST_CONFIG, createTestLogger());
      scheduler.start();
      await wait(150);
      scheduler.stop();

      // thread2 schedule should have been successfully enqueued once
      // (even though threadId schedule failed on each tick)
      expect(thread2Calls.length).toBe(1);
    });

    it('does not advance schedule state when enqueue fails', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, { type: 'interval', expression: '10000' });

      const errorStub = makeQueueStub(() => err(new QueueError('enqueue failed')));
      scheduler = new Scheduler(scheduleRepo, errorStub, FAST_CONFIG, createTestLogger());
      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db.prepare('SELECT next_run_at FROM schedules WHERE id = ?').get(scheduleId) as {
        next_run_at: number;
      };
      // next_run_at should not have been updated to the future
      expect(row.next_run_at).toBeLessThan(Date.now());
    });

    it('handles a findDue database error gracefully without crashing', async () => {
      // Replace scheduleRepo with a stub that returns an error
      const { DbError } = await import('../../../src/core/errors/index.js');
      const faultyRepo = {
        findDue: vi.fn(() => err(new DbError('db is broken'))),
        updateNextRun: vi.fn(() => ok(null)),
        disable: vi.fn(() => ok(undefined)),
      } as unknown as ScheduleRepository;

      scheduler = new Scheduler(faultyRepo, queueStub, FAST_CONFIG, createTestLogger());

      // Should not throw
      scheduler.start();
      await wait(150);
      scheduler.stop();
    });

    it('falls back to empty payload when schedule payload is invalid JSON', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: 'not-json',
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      // enqueue should still be called — scheduler injects personaId and content.
      expect(queueStub.enqueue).toHaveBeenCalledWith(threadId, 'schedule', {
        personaId,
        content: '',
      });
      void scheduleId;
    });
  });
});

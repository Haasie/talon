/**
 * Tick-based task scheduler.
 *
 * On each tick the scheduler queries for all enabled schedules whose
 * next_run_at has elapsed, enqueues them as queue items, and advances
 * their next_run_at (or disables them for one-shot / event-triggered types).
 */

import type pino from 'pino';
import type { ScheduleRepository } from '../core/database/repositories/schedule-repository.js';
import type { ScheduleRow } from '../core/database/repositories/schedule-repository.js';
import type { QueueManager } from '../queue/queue-manager.js';
import { getNextCronTime } from './cron-evaluator.js';
import type { ScheduleConfig } from './schedule-types.js';

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Polls the schedule repository on a fixed interval and enqueues due items.
 *
 * Call `start()` to begin ticking and `stop()` to halt. The scheduler is
 * safe to stop and restart.
 */
export class Scheduler {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly scheduleRepo: ScheduleRepository,
    private readonly queueManager: QueueManager,
    private readonly config: ScheduleConfig,
    private readonly logger: pino.Logger,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Starts the scheduler.
   *
   * Fires an immediate first tick then schedules subsequent ticks at
   * `config.tickIntervalMs` intervals.
   */
  start(): void {
    if (this.running) {
      this.logger.warn('scheduler already running — ignoring start()');
      return;
    }
    this.running = true;
    this.logger.info({ tickIntervalMs: this.config.tickIntervalMs }, 'scheduler started');
    void this.tick();
  }

  /**
   * Stops the scheduler.
   *
   * Clears any pending timer. In-flight tick processing (if any) runs to
   * completion but no new ticks are scheduled.
   */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('scheduler stopped');
  }

  // ---------------------------------------------------------------------------
  // Tick
  // ---------------------------------------------------------------------------

  /**
   * Processes a single scheduler tick.
   *
   * Finds all due schedules, enqueues each one, updates timestamps, and
   * disables one-shot / event schedules. Errors on individual schedules are
   * logged and skipped so one bad schedule cannot block the rest.
   */
  private tick(): void {
    if (!this.running) {
      return;
    }

    const now = Date.now();

    const dueResult = this.scheduleRepo.findDue(now);
    if (dueResult.isErr()) {
      this.logger.error({ err: dueResult.error }, 'scheduler: failed to query due schedules');
    } else {
      const due = dueResult.value;
      this.logger.debug({ count: due.length, now }, 'scheduler tick');

      for (const schedule of due) {
        this.processSchedule(schedule, now);
      }
    }

    // Schedule the next tick only if still running (stop() may have been called
    // while we were awaiting processSchedule calls above).
    if (this.running) {
      this.timer = setTimeout(() => {
        void this.tick();
      }, this.config.tickIntervalMs);
    }
  }

  /**
   * Enqueues a single due schedule and advances its state.
   *
   * @param schedule - The schedule row to process.
   * @param now      - Current epoch ms (used for last_run_at).
   */
  private processSchedule(schedule: ScheduleRow, now: number): void {
    this.logger.info(
      { scheduleId: schedule.id, type: schedule.type, expression: schedule.expression },
      'scheduler: firing schedule',
    );

    // Enqueue only if a thread_id is set; schedules without a thread cannot
    // be enqueued (the queue FK requires an existing thread).
    if (schedule.thread_id === null) {
      this.logger.warn(
        { scheduleId: schedule.id },
        'scheduler: skipping schedule with null thread_id',
      );
      // Still advance / disable so we do not loop on it forever.
    } else {
      let rawPayload: Record<string, unknown> = {};
      try {
        rawPayload = JSON.parse(schedule.payload) as Record<string, unknown>;
      } catch {
        this.logger.warn(
          { scheduleId: schedule.id, raw: schedule.payload },
          'scheduler: schedule has invalid JSON payload — using empty object',
        );
      }

      // Map schedule fields to the payload shape AgentRunner expects:
      // personaId (from schedule row) and content (from payload.prompt).
      const payload: Record<string, unknown> = {
        ...rawPayload,
        personaId: schedule.persona_id,
        content: typeof rawPayload.prompt === 'string' ? rawPayload.prompt : '',
      };

      const enqueueResult = this.queueManager.enqueue(schedule.thread_id, 'schedule', payload);
      if (enqueueResult.isErr()) {
        this.logger.error(
          { scheduleId: schedule.id, err: enqueueResult.error },
          'scheduler: failed to enqueue schedule',
        );
        // Do not advance the schedule so it will be retried on the next tick.
        return;
      }
    }

    // Compute the next run time (null for one_shot / event).
    const nextRun = this.computeNextRun(schedule);

    if (nextRun === null) {
      // One-shot or event-triggered — disable the schedule.
      const disableResult = this.scheduleRepo.disable(schedule.id);
      if (disableResult.isErr()) {
        this.logger.error(
          { scheduleId: schedule.id, err: disableResult.error },
          'scheduler: failed to disable one-shot/event schedule',
        );
      }
      // Also record the last run time.
      this.scheduleRepo.updateNextRun(schedule.id, now, null);
    } else {
      const updateResult = this.scheduleRepo.updateNextRun(schedule.id, now, nextRun);
      if (updateResult.isErr()) {
        this.logger.error(
          { scheduleId: schedule.id, err: updateResult.error },
          'scheduler: failed to update next_run_at',
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Next-run computation
  // ---------------------------------------------------------------------------

  /**
   * Computes the next execution time for a schedule.
   *
   * @param schedule - The schedule row.
   * @returns Epoch ms of the next run, or `null` for types that do not repeat.
   */
  private computeNextRun(schedule: ScheduleRow): number | null {
    switch (schedule.type) {
      case 'cron': {
        const result = getNextCronTime(schedule.expression, new Date());
        if (result.isErr()) {
          this.logger.error(
            { scheduleId: schedule.id, expression: schedule.expression, err: result.error },
            'scheduler: invalid cron expression — disabling schedule',
          );
          return null;
        }
        return result.value;
      }

      case 'interval': {
        const intervalMs = parseInt(schedule.expression, 10);
        if (isNaN(intervalMs) || intervalMs <= 0) {
          this.logger.error(
            { scheduleId: schedule.id, expression: schedule.expression },
            'scheduler: invalid interval expression — disabling schedule',
          );
          return null;
        }
        return Date.now() + intervalMs;
      }

      case 'one_shot':
        // Does not repeat.
        return null;

      case 'event':
        // Event-triggered schedules are not time-based; disable after first fire.
        return null;

      default: {
        // TypeScript exhaustiveness guard.
        const _exhaustive: never = schedule.type;
        this.logger.error(
          { scheduleId: schedule.id, type: _exhaustive },
          'scheduler: unknown schedule type',
        );
        return null;
      }
    }
  }
}

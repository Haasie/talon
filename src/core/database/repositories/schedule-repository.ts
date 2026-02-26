/**
 * Repository for the `schedules` table.
 *
 * Schedules define recurring or one-shot tasks. The scheduler polls
 * `findDue()` on each tick to discover which items need to be enqueued.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Valid schedule type values. */
export type ScheduleType = 'cron' | 'interval' | 'one_shot' | 'event';

/** Row shape matching the `schedules` table exactly. */
export interface ScheduleRow {
  id: string;
  persona_id: string;
  thread_id: string | null;
  type: ScheduleType;
  expression: string;
  payload: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Fields accepted when inserting a new schedule. */
export type InsertScheduleInput = Omit<ScheduleRow, 'created_at' | 'updated_at'>;

/** Repository for reading and writing schedule records. */
export class ScheduleRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findDueStmt: Database.Statement;
  private readonly findByPersonaStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO schedules
        (id, persona_id, thread_id, type, expression, payload, enabled,
         last_run_at, next_run_at, created_at, updated_at)
      VALUES
        (@id, @persona_id, @thread_id, @type, @expression, @payload, @enabled,
         @last_run_at, @next_run_at, @created_at, @updated_at)
    `);

    // A schedule is due when it is enabled and next_run_at has elapsed.
    this.findDueStmt = db.prepare(`
      SELECT * FROM schedules
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `);

    this.findByPersonaStmt = db.prepare(`
      SELECT * FROM schedules WHERE persona_id = ? ORDER BY created_at ASC
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM schedules WHERE id = ?`);
  }

  /** Inserts a new schedule row. */
  insert(input: InsertScheduleInput): Result<ScheduleRow, DbError> {
    try {
      const ts = this.now();
      const row: ScheduleRow = { ...input, created_at: ts, updated_at: ts };
      this.insertStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(new DbError(`Failed to insert schedule: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Returns all enabled schedules whose next_run_at is at or before `now`.
   *
   * @param now - Current time as Unix epoch ms. Defaults to Date.now().
   */
  findDue(now?: number): Result<ScheduleRow[], DbError> {
    try {
      const rows = this.findDueStmt.all(now ?? this.now()) as ScheduleRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find due schedules: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Updates last_run_at and next_run_at after a schedule fires.
   *
   * @param id          - Schedule primary key.
   * @param lastRunAt   - Timestamp of the run that just fired.
   * @param nextRunAt   - Next scheduled execution time (null for one_shot).
   */
  updateNextRun(id: string, lastRunAt: number, nextRunAt: number | null): Result<ScheduleRow | null, DbError> {
    try {
      const stmt = this.db.prepare(`
        UPDATE schedules
        SET last_run_at = @last_run_at, next_run_at = @next_run_at, updated_at = @updated_at
        WHERE id = @id
      `);
      stmt.run({ id, last_run_at: lastRunAt, next_run_at: nextRunAt, updated_at: this.now() });
      const row = this.findByIdStmt.get(id) as ScheduleRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to update schedule next run: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all schedules for a persona. */
  findByPersona(personaId: string): Result<ScheduleRow[], DbError> {
    try {
      const rows = this.findByPersonaStmt.all(personaId) as ScheduleRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find schedules by persona: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Enables a schedule. */
  enable(id: string): Result<void, DbError> {
    return this._setEnabled(id, 1);
  }

  /** Disables a schedule. */
  disable(id: string): Result<void, DbError> {
    return this._setEnabled(id, 0);
  }

  private _setEnabled(id: string, enabled: 0 | 1): Result<void, DbError> {
    try {
      const stmt = this.db.prepare(
        `UPDATE schedules SET enabled = @enabled, updated_at = @updated_at WHERE id = @id`,
      );
      stmt.run({ id, enabled, updated_at: this.now() });
      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to set schedule enabled state: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }
}

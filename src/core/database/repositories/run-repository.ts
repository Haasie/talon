/**
 * Repository for the `runs` table.
 *
 * A run represents one agent execution: it tracks which sandbox was used,
 * the SDK session, token consumption, cost, and final status.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Valid run status values. */
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Row shape matching the `runs` table exactly. */
export interface RunRow {
  id: string;
  thread_id: string;
  persona_id: string;
  sandbox_id: string | null;
  session_id: string | null;
  status: RunStatus;
  parent_run_id: string | null;
  queue_item_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  error: string | null;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

/** Fields accepted when inserting a new run. */
export type InsertRunInput = Omit<RunRow, 'created_at'>;

/** Token usage and cost fields that can be updated. */
export interface UpdateTokensInput {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
}

/** Repository for reading and writing run records. */
export class RunRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findByThreadStmt: Database.Statement;
  private readonly findByParentStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO runs
        (id, thread_id, persona_id, sandbox_id, session_id, status,
         parent_run_id, queue_item_id, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, error,
         started_at, ended_at, created_at)
      VALUES
        (@id, @thread_id, @persona_id, @sandbox_id, @session_id, @status,
         @parent_run_id, @queue_item_id, @input_tokens, @output_tokens,
         @cache_read_tokens, @cache_write_tokens, @cost_usd, @error,
         @started_at, @ended_at, @created_at)
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);

    this.findByThreadStmt = db.prepare(`
      SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at DESC
    `);

    this.findByParentStmt = db.prepare(`
      SELECT * FROM runs WHERE parent_run_id = ? ORDER BY created_at ASC
    `);
  }

  /** Inserts a new run row. */
  insert(input: InsertRunInput): Result<RunRow, DbError> {
    try {
      const row: RunRow = { ...input, created_at: this.now() };
      this.insertStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(new DbError(`Failed to insert run: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Finds a run by its primary key. */
  findById(id: string): Result<RunRow | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as RunRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to find run by id: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all runs for a thread in descending chronological order. */
  findByThread(threadId: string): Result<RunRow[], DbError> {
    try {
      const rows = this.findByThreadStmt.all(threadId) as RunRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find runs by thread: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all child runs spawned by the given parent run. */
  findByParent(parentRunId: string): Result<RunRow[], DbError> {
    try {
      const rows = this.findByParentStmt.all(parentRunId) as RunRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find child runs: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Updates the status (and optional started_at / ended_at) of a run. */
  updateStatus(
    id: string,
    status: RunStatus,
    timestamps?: { started_at?: number; ended_at?: number; error?: string },
  ): Result<RunRow | null, DbError> {
    try {
      const stmt = this.db.prepare(`
        UPDATE runs
        SET status = @status,
            started_at = COALESCE(@started_at, started_at),
            ended_at   = COALESCE(@ended_at,   ended_at),
            error      = COALESCE(@error,       error)
        WHERE id = @id
      `);
      stmt.run({
        id,
        status,
        started_at: timestamps?.started_at ?? null,
        ended_at: timestamps?.ended_at ?? null,
        error: timestamps?.error ?? null,
      });
      return this.findById(id);
    } catch (cause) {
      return err(new DbError(`Failed to update run status: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Updates token usage and cost figures for a run. */
  updateTokens(id: string, tokens: UpdateTokensInput): Result<RunRow | null, DbError> {
    try {
      const stmt = this.db.prepare(`
        UPDATE runs
        SET input_tokens        = COALESCE(@input_tokens,        input_tokens),
            output_tokens       = COALESCE(@output_tokens,       output_tokens),
            cache_read_tokens   = COALESCE(@cache_read_tokens,   cache_read_tokens),
            cache_write_tokens  = COALESCE(@cache_write_tokens,  cache_write_tokens),
            cost_usd            = COALESCE(@cost_usd,            cost_usd)
        WHERE id = @id
      `);
      stmt.run({
        id,
        input_tokens: tokens.input_tokens ?? null,
        output_tokens: tokens.output_tokens ?? null,
        cache_read_tokens: tokens.cache_read_tokens ?? null,
        cache_write_tokens: tokens.cache_write_tokens ?? null,
        cost_usd: tokens.cost_usd ?? null,
      });
      return this.findById(id);
    } catch (cause) {
      return err(new DbError(`Failed to update run tokens: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }
}

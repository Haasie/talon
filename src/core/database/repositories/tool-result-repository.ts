/**
 * Repository for the `tool_results` table.
 *
 * Stores cached tool execution results keyed by (run_id, request_id) so that
 * the daemon can replay tool results idempotently after a crash or retry.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Valid tool result status values. */
export type ToolResultStatus = 'success' | 'error' | 'timeout';

/** Row shape matching the `tool_results` table exactly. */
export interface ToolResultRow {
  run_id: string;
  request_id: string;
  tool: string;
  result: string;
  status: ToolResultStatus;
  created_at: number;
}

/** Fields accepted when inserting a tool result. */
export type InsertToolResultInput = Omit<ToolResultRow, 'created_at'>;

/** Repository for idempotent tool result caching. */
export class ToolResultRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByRunAndRequestStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO tool_results (run_id, request_id, tool, result, status, created_at)
      VALUES (@run_id, @request_id, @tool, @result, @status, @created_at)
    `);

    this.findByRunAndRequestStmt = db.prepare(`
      SELECT * FROM tool_results WHERE run_id = ? AND request_id = ?
    `);
  }

  /** Stores a tool execution result in the idempotency cache. */
  insert(input: InsertToolResultInput): Result<ToolResultRow, DbError> {
    try {
      const row: ToolResultRow = { ...input, created_at: this.now() };
      this.insertStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(new DbError(`Failed to insert tool result: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Looks up a cached tool result by run and request identifiers.
   *
   * Returns null if no result exists for this (run_id, request_id) pair,
   * indicating the tool has not yet been executed in this run.
   */
  findByRunAndRequest(runId: string, requestId: string): Result<ToolResultRow | null, DbError> {
    try {
      const row = this.findByRunAndRequestStmt.get(runId, requestId) as ToolResultRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to find tool result: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }
}

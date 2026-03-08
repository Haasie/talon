/**
 * Repository for the `audit_log` table.
 *
 * The audit log is append-only: this repository intentionally exposes no
 * update or delete methods. Every side-effecting operation in the daemon
 * should be recorded here with enough context for forensic analysis.
 */

import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import type { AuditEntry, AuditStore } from '../../logging/audit-logger.js';

/** Row shape matching the `audit_log` table exactly. */
export interface AuditLogRow {
  id: string;
  run_id: string | null;
  thread_id: string | null;
  persona_id: string | null;
  action: string;
  tool: string | null;
  request_id: string | null;
  details: string;
  created_at: number;
}

/** Fields accepted when inserting an audit log entry. */
export type InsertAuditLogInput = Omit<AuditLogRow, 'created_at'>;

/** Repository for the append-only audit log. */
export class AuditRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByRunStmt: Database.Statement;
  private readonly findByThreadStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO audit_log
        (id, run_id, thread_id, persona_id, action, tool, request_id, details, created_at)
      VALUES
        (@id, @run_id, @thread_id, @persona_id, @action, @tool, @request_id, @details, @created_at)
    `);

    this.findByRunStmt = db.prepare(`
      SELECT * FROM audit_log WHERE run_id = ? ORDER BY created_at ASC
    `);

    this.findByThreadStmt = db.prepare(`
      SELECT * FROM audit_log WHERE thread_id = ? ORDER BY created_at ASC
    `);
  }

  /**
   * Appends a new audit log entry.
   *
   * This is the only mutating operation exposed by this repository.
   */
  insert(input: InsertAuditLogInput): Result<AuditLogRow, DbError> {
    try {
      const row: AuditLogRow = { ...input, created_at: this.now() };
      this.insertStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(new DbError(`Failed to insert audit log entry: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all audit entries for a given run in chronological order. */
  findByRun(runId: string): Result<AuditLogRow[], DbError> {
    try {
      const rows = this.findByRunStmt.all(runId) as AuditLogRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find audit log by run: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all audit entries for a given thread in chronological order. */
  findByThread(threadId: string): Result<AuditLogRow[], DbError> {
    try {
      const rows = this.findByThreadStmt.all(threadId) as AuditLogRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find audit log by thread: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /**
   * Returns audit entries matching a specific action within an optional time range.
   *
   * @param action    - Exact action string to filter on (e.g. 'tool.execute').
   * @param fromMs    - Optional inclusive start timestamp (Unix epoch ms).
   * @param toMs      - Optional inclusive end timestamp (Unix epoch ms).
   */
  findByAction(action: string, fromMs?: number, toMs?: number): Result<AuditLogRow[], DbError> {
    try {
      let stmt: Database.Statement;
      let rows: AuditLogRow[];

      if (fromMs !== undefined && toMs !== undefined) {
        stmt = this.db.prepare(
          `SELECT * FROM audit_log
           WHERE action = ? AND created_at >= ? AND created_at <= ?
           ORDER BY created_at ASC`,
        );
        rows = stmt.all(action, fromMs, toMs) as AuditLogRow[];
      } else if (fromMs !== undefined) {
        stmt = this.db.prepare(
          `SELECT * FROM audit_log
           WHERE action = ? AND created_at >= ?
           ORDER BY created_at ASC`,
        );
        rows = stmt.all(action, fromMs) as AuditLogRow[];
      } else if (toMs !== undefined) {
        stmt = this.db.prepare(
          `SELECT * FROM audit_log
           WHERE action = ? AND created_at <= ?
           ORDER BY created_at ASC`,
        );
        rows = stmt.all(action, toMs) as AuditLogRow[];
      } else {
        stmt = this.db.prepare(
          `SELECT * FROM audit_log WHERE action = ? ORDER BY created_at ASC`,
        );
        rows = stmt.all(action) as AuditLogRow[];
      }

      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find audit log by action: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }
}

// ---------------------------------------------------------------------------
// AuditStore implementation backed by AuditRepository
// ---------------------------------------------------------------------------

/** Bridges the AuditStore interface to the AuditRepository for SQLite persistence. */
export class RepositoryAuditStore implements AuditStore {
  constructor(private readonly auditRepo: AuditRepository) {}

  append(entry: AuditEntry): void {
    this.auditRepo.insert({
      id: uuidv4(),
      run_id: entry.runId ?? null,
      thread_id: entry.threadId ?? null,
      persona_id: entry.personaId ?? null,
      action: entry.action,
      tool: entry.tool ?? null,
      request_id: entry.requestId ?? null,
      details: JSON.stringify(entry.details),
    });
  }
}

/**
 * Repository for the `artifacts` table.
 *
 * Artifacts are files produced during a run (images, documents, data files).
 * They are referenced by relative path within the thread's artifact directory.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Row shape matching the `artifacts` table exactly. */
export interface ArtifactRow {
  id: string;
  run_id: string;
  thread_id: string;
  path: string;
  mime_type: string | null;
  size: number;
  checksum: string | null;
  created_at: number;
}

/** Fields accepted when inserting a new artifact. */
export type InsertArtifactInput = Omit<ArtifactRow, 'created_at'>;

/** Repository for reading and writing artifact records. */
export class ArtifactRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByRunStmt: Database.Statement;
  private readonly findByThreadStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO artifacts (id, run_id, thread_id, path, mime_type, size, checksum, created_at)
      VALUES (@id, @run_id, @thread_id, @path, @mime_type, @size, @checksum, @created_at)
    `);

    this.findByRunStmt = db.prepare(`
      SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC
    `);

    this.findByThreadStmt = db.prepare(`
      SELECT * FROM artifacts WHERE thread_id = ? ORDER BY created_at DESC
    `);
  }

  /** Inserts a new artifact row. */
  insert(input: InsertArtifactInput): Result<ArtifactRow, DbError> {
    try {
      const row: ArtifactRow = { ...input, created_at: this.now() };
      this.insertStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(new DbError(`Failed to insert artifact: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all artifacts produced by the given run. */
  findByRun(runId: string): Result<ArtifactRow[], DbError> {
    try {
      const rows = this.findByRunStmt.all(runId) as ArtifactRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find artifacts by run: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all artifacts associated with the given thread. */
  findByThread(threadId: string): Result<ArtifactRow[], DbError> {
    try {
      const rows = this.findByThreadStmt.all(threadId) as ArtifactRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find artifacts by thread: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }
}

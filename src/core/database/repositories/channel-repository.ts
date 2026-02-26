/**
 * Repository for the `channels` table.
 *
 * Channels represent external messaging integrations (Telegram, Slack, etc.).
 * All mutating operations use prepared statements for safety and performance.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Row shape matching the `channels` table exactly. */
export interface ChannelRow {
  id: string;
  type: string;
  name: string;
  config: string;
  credentials_ref: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

/** Fields accepted when inserting a new channel. */
export type InsertChannelInput = Omit<ChannelRow, 'created_at' | 'updated_at'>;

/** Fields that may be updated on an existing channel. */
export type UpdateChannelInput = Partial<
  Pick<ChannelRow, 'type' | 'name' | 'config' | 'credentials_ref' | 'enabled'>
>;

/** Repository for reading and writing channel records. */
export class ChannelRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;
  private readonly findByNameStmt: Database.Statement;
  private readonly findByTypeStmt: Database.Statement;
  private readonly findEnabledStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT INTO channels (id, type, name, config, credentials_ref, enabled, created_at, updated_at)
      VALUES (@id, @type, @name, @config, @credentials_ref, @enabled, @created_at, @updated_at)
    `);

    this.findByIdStmt = db.prepare(`
      SELECT * FROM channels WHERE id = ?
    `);

    this.findByNameStmt = db.prepare(`
      SELECT * FROM channels WHERE name = ?
    `);

    this.findByTypeStmt = db.prepare(`
      SELECT * FROM channels WHERE type = ?
    `);

    this.findEnabledStmt = db.prepare(`
      SELECT * FROM channels WHERE enabled = 1
    `);

    this.deleteStmt = db.prepare(`
      DELETE FROM channels WHERE id = ?
    `);
  }

  /** Inserts a new channel row. */
  insert(input: InsertChannelInput): Result<ChannelRow, DbError> {
    try {
      const ts = this.now();
      const row: ChannelRow = { ...input, created_at: ts, updated_at: ts };
      this.insertStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(new DbError(`Failed to insert channel: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Finds a channel by its primary key. */
  findById(id: string): Result<ChannelRow | null, DbError> {
    try {
      const row = this.findByIdStmt.get(id) as ChannelRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to find channel by id: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Finds a channel by its unique name. */
  findByName(name: string): Result<ChannelRow | null, DbError> {
    try {
      const row = this.findByNameStmt.get(name) as ChannelRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to find channel by name: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all channels of the given type. */
  findByType(type: string): Result<ChannelRow[], DbError> {
    try {
      const rows = this.findByTypeStmt.all(type) as ChannelRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find channels by type: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Returns all enabled channels. */
  findEnabled(): Result<ChannelRow[], DbError> {
    try {
      const rows = this.findEnabledStmt.all() as ChannelRow[];
      return ok(rows);
    } catch (cause) {
      return err(new DbError(`Failed to find enabled channels: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Updates mutable fields on an existing channel. */
  update(id: string, fields: UpdateChannelInput): Result<ChannelRow | null, DbError> {
    try {
      const setClause = Object.keys(fields)
        .map((k) => `${k} = @${k}`)
        .join(', ');
      if (!setClause) {
        return this.findById(id);
      }
      const stmt = this.db.prepare(
        `UPDATE channels SET ${setClause}, updated_at = @updated_at WHERE id = @id`,
      );
      stmt.run({ ...fields, updated_at: this.now(), id });
      return this.findById(id);
    } catch (cause) {
      return err(new DbError(`Failed to update channel: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Deletes a channel by id (cascades to bindings and threads). */
  delete(id: string): Result<void, DbError> {
    try {
      this.deleteStmt.run(id);
      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to delete channel: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }
}

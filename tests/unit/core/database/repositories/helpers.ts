/**
 * Shared test helpers for repository tests.
 *
 * Provides a fully-migrated in-memory SQLite database and UUID generation.
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { runMigrations } from '../../../../../src/core/database/migrations/runner.js';

/** Returns the absolute path to the SQL migrations directory. */
function migrationsDir(): string {
  return join(import.meta.dirname, '../../../../../src/core/database/migrations');
}

/**
 * Creates a fresh in-memory SQLite database with all migrations applied.
 * Throws if migrations fail (test setup failure — not a domain error).
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const result = runMigrations(db, migrationsDir());
  if (result.isErr()) {
    throw new Error(`Test DB migration failed: ${result.error.message}`);
  }
  return db;
}

/** Generates a random UUID string for use in tests. */
export function uuid(): string {
  return uuidv4();
}

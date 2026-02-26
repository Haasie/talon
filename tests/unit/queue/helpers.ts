/**
 * Shared test helpers for queue unit tests.
 *
 * Provides a fully-migrated in-memory SQLite database, repository instances,
 * and seed data utilities for testing queue components.
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';

/** Absolute path to SQL migrations for test database setup. */
function migrationsDir(): string {
  return join(import.meta.dirname, '../../../src/core/database/migrations');
}

/**
 * Creates a fully-migrated in-memory SQLite database.
 * Throws on migration failure (test setup error, not domain error).
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

/** Generates a random UUID. */
export function uuid(): string {
  return uuidv4();
}

/** Creates a silent pino logger for use in tests. */
export function createTestLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

/**
 * Seeds a channel and thread into the database, returning the thread ID.
 * Used to satisfy FK constraints when enqueueing items.
 */
export function seedThread(db: Database.Database): string {
  const channels = new ChannelRepository(db);
  const threads = new ThreadRepository(db);

  const channelId = uuid();
  channels.insert({
    id: channelId,
    type: 'telegram',
    name: `ch-${uuid()}`,
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });

  const threadId = uuid();
  threads.insert({
    id: threadId,
    channel_id: channelId,
    external_id: `ext-${uuid()}`,
    metadata: '{}',
  });

  return threadId;
}

/**
 * Enqueues a minimal item via the QueueRepository and returns its row ID.
 */
export function enqueueItem(
  repo: QueueRepository,
  threadId: string,
  overrides: Partial<Parameters<QueueRepository['enqueue']>[0]> = {},
): string {
  const id = uuid();
  const result = repo.enqueue({
    id,
    thread_id: threadId,
    message_id: null,
    type: 'message',
    payload: '{}',
    max_attempts: 3,
    ...overrides,
  });
  if (result.isErr()) {
    throw new Error(`Failed to enqueue test item: ${result.error.message}`);
  }
  return id;
}

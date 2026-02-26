/**
 * Shared test helpers for memory subsystem tests.
 *
 * Provides a fully-migrated in-memory SQLite database, common repository
 * constructors, a temp-directory-backed ThreadWorkspace, and a no-op logger.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';

import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { MemoryRepository } from '../../../src/core/database/repositories/memory-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ThreadWorkspace } from '../../../src/memory/thread-workspace.js';
import { MemoryManager } from '../../../src/memory/memory-manager.js';

/** Returns the absolute path to the SQL migrations directory. */
function migrationsDir(): string {
  return join(import.meta.dirname, '../../../src/core/database/migrations');
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

/** Creates a temp directory and returns its path. */
export function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-manager-test-'));
}

/** Creates a silent (no-output) pino logger for tests. */
export function createSilentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

/**
 * Seeds a channel + thread in the DB and returns the threadId.
 * Used by tests that need a valid FK-backed thread.
 */
export function seedThread(db: Database.Database): string {
  const channelRepo = new ChannelRepository(db);
  const channelId = uuid();
  channelRepo.insert({
    id: channelId,
    type: 'telegram',
    name: `ch-${uuid()}`,
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });

  const threadRepo = new ThreadRepository(db);
  const threadId = uuid();
  threadRepo.insert({
    id: threadId,
    channel_id: channelId,
    external_id: `ext-${uuid()}`,
    metadata: '{}',
  });

  return threadId;
}

/**
 * Creates a fully wired MemoryManager backed by an in-memory DB and a
 * temporary filesystem directory. Callers are responsible for closing the DB
 * and deleting the temp dir in afterEach.
 */
export function createMemoryManager(
  db: Database.Database,
  dataDir: string,
): MemoryManager {
  const memoryRepo = new MemoryRepository(db);
  const messageRepo = new MessageRepository(db);
  const workspace = new ThreadWorkspace(dataDir);
  const logger = createSilentLogger();
  return new MemoryManager(memoryRepo, messageRepo, workspace, logger);
}

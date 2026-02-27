/**
 * Integration tests for queue durability.
 *
 * Tests that the queue survives process crashes by using a file-based SQLite
 * database, closing and re-opening it, running crash recovery, and verifying
 * items can still be processed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { ok, err } from 'neverthrow';

import { runMigrations } from '../../src/core/database/migrations/runner.js';
import { QueueRepository } from '../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../src/core/database/repositories/channel-repository.js';
import { QueueManager, type QueueConfig } from '../../src/queue/queue-manager.js';
import { QueueItemStatus } from '../../src/queue/queue-types.js';
import { recoverFromCrash } from '../../src/daemon/lifecycle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function migrationsDir(): string {
  return join(import.meta.dirname, '../../src/core/database/migrations');
}

function openAndMigrateDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  const result = runMigrations(db, migrationsDir());
  if (result.isErr()) {
    throw new Error(`Migration failed: ${result.error.message}`);
  }
  return db;
}

function createTestLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function seedThread(db: Database.Database): string {
  const channels = new ChannelRepository(db);
  const threads = new ThreadRepository(db);

  const channelId = uuidv4();
  channels.insert({
    id: channelId,
    type: 'mock',
    name: `ch-${uuidv4()}`,
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });

  const threadId = uuidv4();
  threads.insert({
    id: threadId,
    channel_id: channelId,
    external_id: `ext-${uuidv4()}`,
    metadata: '{}',
  });

  return threadId;
}

function enqueueDirectly(
  db: Database.Database,
  threadId: string,
  overrides: { status?: string; attempts?: number; next_retry_at?: number | null } = {},
): string {
  const id = uuidv4();
  const now = Date.now();
  const status = overrides.status ?? 'pending';
  const attempts = overrides.attempts ?? 0;
  const nextRetryAt = overrides.next_retry_at ?? null;

  db.prepare(`
    INSERT INTO queue_items
      (id, thread_id, message_id, type, status, attempts, max_attempts,
       next_retry_at, error, payload, claimed_at, created_at, updated_at)
    VALUES (?, ?, NULL, 'message', ?, ?, 3, ?, NULL, '{"test":true}', NULL, ?, ?)
  `).run(id, threadId, status, attempts, nextRetryAt, now, now);

  return id;
}

const DEFAULT_CONFIG: QueueConfig = {
  maxAttempts: 3,
  backoffBaseMs: 100,
  backoffMaxMs: 5000,
  concurrencyLimit: 4,
};

const POLL_WAIT_MS = 1200;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Queue durability', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'queue-durability-'));
    dbPath = join(tmpDir, 'test.sqlite');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Persistence: enqueue → crash → recover → process
  // -------------------------------------------------------------------------

  describe('enqueue → crash → recover → process', () => {
    it('items enqueued before db close are present after reopen', () => {
      // "Session 1": open db, enqueue items, close (simulating crash)
      const db1 = openAndMigrateDb(dbPath);
      const threadId = seedThread(db1);
      const queueRepo1 = new QueueRepository(db1);

      const id1 = uuidv4();
      const id2 = uuidv4();
      const now = Date.now();
      for (const id of [id1, id2]) {
        db1.prepare(`
          INSERT INTO queue_items
            (id, thread_id, message_id, type, status, attempts, max_attempts,
             next_retry_at, error, payload, claimed_at, created_at, updated_at)
          VALUES (?, ?, NULL, 'message', 'pending', 0, 3, NULL, NULL, '{}', NULL, ?, ?)
        `).run(id, threadId, now, now);
      }

      // Close simulates crash
      db1.close();

      // "Session 2": reopen db and verify items still present
      const db2 = openAndMigrateDb(dbPath);
      const queueRepo2 = new QueueRepository(db2);

      const pending = queueRepo2.findPending()._unsafeUnwrap();
      const pendingIds = pending.map((r) => r.id);

      expect(pendingIds).toContain(id1);
      expect(pendingIds).toContain(id2);

      db2.close();
    });

    it('items survive crash and can be processed after recovery', async () => {
      // "Session 1": enqueue items then crash
      const db1 = openAndMigrateDb(dbPath);
      const threadId = seedThread(db1);
      enqueueDirectly(db1, threadId);
      db1.close();

      // "Session 2": reopen, recover, process
      const db2 = openAndMigrateDb(dbPath);
      const queueRepo2 = new QueueRepository(db2);
      const threadRepo2 = new ThreadRepository(db2);
      const logger = createTestLogger();

      recoverFromCrash(queueRepo2, logger);

      const manager = new QueueManager(queueRepo2, threadRepo2, DEFAULT_CONFIG, logger);
      const processed: string[] = [];

      manager.startProcessing(async (item) => {
        processed.push(item.id);
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      expect(processed).toHaveLength(1);

      db2.close();
    });

    it('multiple items survive crash and all are processed after recovery', async () => {
      const db1 = openAndMigrateDb(dbPath);
      const threadId = seedThread(db1);
      const ids: string[] = [];

      for (let i = 0; i < 5; i++) {
        const id = enqueueDirectly(db1, threadId);
        ids.push(id);
      }
      db1.close();

      const db2 = openAndMigrateDb(dbPath);
      const queueRepo2 = new QueueRepository(db2);
      const threadRepo2 = new ThreadRepository(db2);
      const logger = createTestLogger();

      recoverFromCrash(queueRepo2, logger);

      const manager = new QueueManager(queueRepo2, threadRepo2, DEFAULT_CONFIG, logger);
      const processed: string[] = [];

      manager.startProcessing(async (item) => {
        processed.push(item.id);
        return ok(undefined);
      });

      // Wait enough for all 5 items to be processed (FIFO, one per poll tick)
      await new Promise((r) => setTimeout(r, 3500));
      manager.stopProcessing();

      expect(processed).toHaveLength(5);
      for (const id of ids) {
        expect(processed).toContain(id);
      }

      db2.close();
    });
  });

  // -------------------------------------------------------------------------
  // In-flight crash recovery
  // -------------------------------------------------------------------------

  describe('in-flight item crash recovery', () => {
    it('recoverFromCrash resets claimed items to pending', () => {
      const db = openAndMigrateDb(dbPath);
      const threadId = seedThread(db);
      const queueRepo = new QueueRepository(db);

      // Simulate an item that was claimed but the process crashed
      const claimedId = enqueueDirectly(db, threadId, { status: 'claimed' });

      const logger = createTestLogger();
      recoverFromCrash(queueRepo, logger);

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(claimedId) as {
        status: string;
      };
      expect(row.status).toBe('pending');

      db.close();
    });

    it('recoverFromCrash resets processing items to pending', () => {
      const db = openAndMigrateDb(dbPath);
      const threadId = seedThread(db);
      const queueRepo = new QueueRepository(db);

      const processingId = enqueueDirectly(db, threadId, { status: 'processing' });

      recoverFromCrash(queueRepo, createTestLogger());

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(processingId) as {
        status: string;
      };
      expect(row.status).toBe('pending');

      db.close();
    });

    it('recoverFromCrash resets multiple in-flight items', () => {
      const db = openAndMigrateDb(dbPath);
      const threadId1 = seedThread(db);
      const threadId2 = seedThread(db);
      const queueRepo = new QueueRepository(db);

      const id1 = enqueueDirectly(db, threadId1, { status: 'claimed' });
      const id2 = enqueueDirectly(db, threadId2, { status: 'processing' });
      // This one is pending and should not be touched
      const id3 = enqueueDirectly(db, threadId1, { status: 'pending' });

      recoverFromCrash(queueRepo, createTestLogger());

      const row1 = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id1) as { status: string };
      const row2 = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id2) as { status: string };
      const row3 = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id3) as { status: string };

      expect(row1.status).toBe('pending');
      expect(row2.status).toBe('pending');
      expect(row3.status).toBe('pending'); // was already pending

      db.close();
    });

    it('recoverFromCrash does not affect completed or dead_letter items', () => {
      const db = openAndMigrateDb(dbPath);
      const threadId = seedThread(db);
      const queueRepo = new QueueRepository(db);

      const completedId = enqueueDirectly(db, threadId, { status: 'completed' });
      const dlId = enqueueDirectly(db, threadId, { status: 'dead_letter' });

      recoverFromCrash(queueRepo, createTestLogger());

      const completedRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(completedId) as { status: string };
      const dlRow = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(dlId) as { status: string };

      expect(completedRow.status).toBe('completed');
      expect(dlRow.status).toBe('dead_letter');

      db.close();
    });

    it('in-flight items after crash recovery can be processed', async () => {
      const db = openAndMigrateDb(dbPath);
      const threadId = seedThread(db);
      const queueRepo = new QueueRepository(db);
      const threadRepo = new ThreadRepository(db);

      // Simulate crash with claimed item
      const claimedId = enqueueDirectly(db, threadId, { status: 'claimed' });

      // Run crash recovery
      recoverFromCrash(queueRepo, createTestLogger());

      // Now process the recovered item
      const manager = new QueueManager(queueRepo, threadRepo, DEFAULT_CONFIG, createTestLogger());
      const processed: string[] = [];

      manager.startProcessing(async (item) => {
        processed.push(item.id);
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      expect(processed).toContain(claimedId);

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(claimedId) as {
        status: string;
      };
      expect(row.status).toBe('completed');

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // DLQ items survive crash
  // -------------------------------------------------------------------------

  describe('DLQ items survive crash', () => {
    it('dead_letter items are present after db reopen', () => {
      const db1 = openAndMigrateDb(dbPath);
      const threadId = seedThread(db1);
      const dlId = enqueueDirectly(db1, threadId, { status: 'dead_letter' });
      db1.close();

      const db2 = openAndMigrateDb(dbPath);
      const queueRepo2 = new QueueRepository(db2);

      const dlItems = queueRepo2.findDeadLetter()._unsafeUnwrap();
      const dlIds = dlItems.map((r) => r.id);

      expect(dlIds).toContain(dlId);

      db2.close();
    });

    it('recoverFromCrash does not touch dead_letter items', () => {
      const db = openAndMigrateDb(dbPath);
      const threadId = seedThread(db);
      const queueRepo = new QueueRepository(db);

      const dlId = enqueueDirectly(db, threadId, { status: 'dead_letter' });
      recoverFromCrash(queueRepo, createTestLogger());

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(dlId) as {
        status: string;
      };
      expect(row.status).toBe('dead_letter');

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // Queue ordering preserved after recovery
  // -------------------------------------------------------------------------

  describe('queue ordering preserved after recovery', () => {
    it('FIFO order is maintained after crash recovery', async () => {
      const db1 = openAndMigrateDb(dbPath);
      const threadId = seedThread(db1);

      // Enqueue items with explicit timestamps to control order
      const now = Date.now();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = uuidv4();
        ids.push(id);
        db1.prepare(`
          INSERT INTO queue_items
            (id, thread_id, message_id, type, status, attempts, max_attempts,
             next_retry_at, error, payload, claimed_at, created_at, updated_at)
          VALUES (?, ?, NULL, 'message', 'pending', 0, 3, NULL, NULL, ?, NULL, ?, ?)
        `).run(id, threadId, JSON.stringify({ order: i + 1 }), now + i, now + i);
      }

      db1.close();

      const db2 = openAndMigrateDb(dbPath);
      const queueRepo2 = new QueueRepository(db2);
      const threadRepo2 = new ThreadRepository(db2);

      recoverFromCrash(queueRepo2, createTestLogger());

      const manager = new QueueManager(queueRepo2, threadRepo2, DEFAULT_CONFIG, createTestLogger());
      const processedOrders: number[] = [];

      manager.startProcessing(async (item) => {
        processedOrders.push(Number(item.payload['order']));
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, 2500));
      manager.stopProcessing();

      expect(processedOrders).toHaveLength(3);
      expect(processedOrders).toEqual([1, 2, 3]);

      db2.close();
    });

    it('failed items with past retry times are processed in order after recovery', async () => {
      const db = openAndMigrateDb(dbPath);
      const threadId = seedThread(db);
      const queueRepo = new QueueRepository(db);
      const threadRepo = new ThreadRepository(db);

      const now = Date.now();
      // Insert a failed item with a past retry time (should be processable)
      const failedId = uuidv4();
      db.prepare(`
        INSERT INTO queue_items
          (id, thread_id, message_id, type, status, attempts, max_attempts,
           next_retry_at, error, payload, claimed_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'message', 'failed', 1, 3, ?, 'prev failure', '{}', NULL, ?, ?)
      `).run(failedId, threadId, now - 5000, now - 10000, now);

      recoverFromCrash(queueRepo, createTestLogger());

      const manager = new QueueManager(queueRepo, threadRepo, DEFAULT_CONFIG, createTestLogger());
      const processed: string[] = [];

      manager.startProcessing(async (item) => {
        processed.push(item.id);
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      expect(processed).toContain(failedId);

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // File-based vs in-memory parity
  // -------------------------------------------------------------------------

  describe('file-based database parity with in-memory', () => {
    it('file-based db behaves identically to in-memory for enqueue/process', async () => {
      const db = openAndMigrateDb(dbPath);
      const threadId = seedThread(db);
      const queueRepo = new QueueRepository(db);
      const threadRepo = new ThreadRepository(db);

      const manager = new QueueManager(queueRepo, threadRepo, DEFAULT_CONFIG, createTestLogger());
      const item = manager.enqueue(threadId, 'message', { test: true })._unsafeUnwrap();

      expect(item.status).toBe(QueueItemStatus.Pending);

      manager.startProcessing(async () => ok(undefined));
      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(item.id) as {
        status: string;
      };
      expect(row.status).toBe('completed');

      db.close();
    });

    it('stats work correctly with file-based db', () => {
      const db = openAndMigrateDb(dbPath);
      const threadId = seedThread(db);
      const queueRepo = new QueueRepository(db);
      const threadRepo = new ThreadRepository(db);

      const manager = new QueueManager(queueRepo, threadRepo, DEFAULT_CONFIG, createTestLogger());
      manager.enqueue(threadId, 'message', {});
      manager.enqueue(threadId, 'message', {});

      const stats = manager.stats();
      expect(stats.pending).toBe(2);

      db.close();
    });
  });
});

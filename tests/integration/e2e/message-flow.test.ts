/**
 * End-to-end integration tests for the full message flow.
 *
 * Exercises the complete path: inbound event → queue → handler → outbound.
 * Uses a real in-memory SQLite database, real repositories, real queue
 * manager, and a mock channel connector — no internal mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { ok, err } from 'neverthrow';

import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { QueueManager, type QueueConfig } from '../../../src/queue/queue-manager.js';
import { QueueItemStatus, type QueueItem } from '../../../src/queue/queue-types.js';
import { ChannelError } from '../../../src/core/errors/error-types.js';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../../src/channels/channel-types.js';
import type { Result } from '../../../src/core/types/result.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function migrationsDir(): string {
  return join(import.meta.dirname, '../../../src/core/database/migrations');
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const result = runMigrations(db, migrationsDir());
  if (result.isErr()) {
    throw new Error(`Test DB migration failed: ${result.error.message}`);
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

// ---------------------------------------------------------------------------
// Mock connector
// ---------------------------------------------------------------------------

class MockConnector implements ChannelConnector {
  readonly type = 'mock';
  readonly name: string;
  private messageHandler?: (event: InboundEvent) => Promise<void>;
  running = false;
  sentMessages: Array<{ threadId: string; output: AgentOutput }> = [];
  startCallCount = 0;
  stopCallCount = 0;

  constructor(name: string) {
    this.name = name;
  }

  async start(): Promise<void> {
    this.running = true;
    this.startCallCount++;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopCallCount++;
  }

  onMessage(handler: (event: InboundEvent) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async send(threadId: string, output: AgentOutput): Promise<Result<void, ChannelError>> {
    this.sentMessages.push({ threadId, output });
    return ok(undefined);
  }

  format(markdown: string): string {
    return markdown;
  }

  async simulateInbound(event: InboundEvent): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: QueueConfig = {
  maxAttempts: 3,
  backoffBaseMs: 100,
  backoffMaxMs: 5000,
  concurrencyLimit: 4,
};

const FAST_CONFIG: QueueConfig = {
  maxAttempts: 1,
  backoffBaseMs: 50,
  backoffMaxMs: 500,
  concurrencyLimit: 4,
};

const POLL_WAIT_MS = 1200; // Wait at least 2 poll intervals (500ms each)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('End-to-end message flow', () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let threadRepo: ThreadRepository;
  let manager: QueueManager;
  let connector: MockConnector;
  let threadId: string;

  beforeEach(() => {
    db = createTestDb();
    queueRepo = new QueueRepository(db);
    threadRepo = new ThreadRepository(db);
    manager = new QueueManager(queueRepo, threadRepo, DEFAULT_CONFIG, createTestLogger());
    connector = new MockConnector('test-connector');
    threadId = seedThread(db);
  });

  afterEach(() => {
    manager.stopProcessing();
    db.close();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('happy path: inbound → enqueue → process → outbound', () => {
    it('processes an enqueued message item to completion', async () => {
      const enqueueResult = manager.enqueue(threadId, 'message', { content: 'hello world' });
      expect(enqueueResult.isOk()).toBe(true);

      const item = enqueueResult._unsafeUnwrap();
      expect(item.status).toBe(QueueItemStatus.Pending);

      const processed: QueueItem[] = [];
      manager.startProcessing(async (queueItem) => {
        processed.push(queueItem);
        const output: AgentOutput = { body: `Reply to: ${String(queueItem.payload['content'])}` };
        await connector.send(threadId, output);
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      expect(processed).toHaveLength(1);
      expect(processed[0]?.threadId).toBe(threadId);
      expect(processed[0]?.type).toBe('message');

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(item.id) as { status: string };
      expect(row.status).toBe('completed');

      expect(connector.sentMessages).toHaveLength(1);
      expect(connector.sentMessages[0]?.output.body).toBe('Reply to: hello world');
    });

    it('queue item payload is accessible in handler', async () => {
      const payload = { key: 'test-key', nested: { value: 42 } };
      manager.enqueue(threadId, 'message', payload);

      let capturedPayload: Record<string, unknown> | undefined;
      manager.startProcessing(async (item) => {
        capturedPayload = item.payload;
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      expect(capturedPayload).toEqual(payload);
    });

    it('supports all queue item types through the full flow', async () => {
      const types: Array<'message' | 'schedule' | 'collaboration'> = [
        'message',
        'schedule',
        'collaboration',
      ];

      // Need a thread for each type
      const thread2 = seedThread(db);
      const thread3 = seedThread(db);
      const threads = [threadId, thread2, thread3];

      for (let i = 0; i < types.length; i++) {
        manager.enqueue(threads[i]!, types[i]!, { index: i });
      }

      const processedTypes: string[] = [];
      manager.startProcessing(async (item) => {
        processedTypes.push(item.type);
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      expect(processedTypes.sort()).toEqual(['collaboration', 'message', 'schedule']);
    });

    it('handler receives correct item metadata', async () => {
      const enqueueResult = manager.enqueue(threadId, 'message', { data: 'test' });
      const enqueuedItem = enqueueResult._unsafeUnwrap();

      let handlerItem: QueueItem | undefined;
      manager.startProcessing(async (item) => {
        handlerItem = item;
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      expect(handlerItem?.id).toBe(enqueuedItem.id);
      expect(handlerItem?.threadId).toBe(threadId);
      expect(handlerItem?.maxAttempts).toBe(DEFAULT_CONFIG.maxAttempts);
      expect(handlerItem?.attempts).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error + retry
  // -------------------------------------------------------------------------

  describe('error handling: handler fails → item retried', () => {
    it('marks item as failed after handler error', async () => {
      const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();

      manager.startProcessing(async () => err(new Error('processing failed')));
      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      const row = db.prepare('SELECT status, attempts, error FROM queue_items WHERE id = ?').get(item.id) as {
        status: string;
        attempts: number;
        error: string | null;
      };
      expect(row.status).toBe('failed');
      expect(row.attempts).toBeGreaterThanOrEqual(1);
      expect(row.error).toBe('processing failed');
    });

    it('increments attempts on each failure', async () => {
      // Use a special config with max_attempts=3 but we only let it try twice
      const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();

      let callCount = 0;
      manager.startProcessing(async () => {
        callCount++;
        return err(new Error(`failure ${callCount}`));
      });

      // Let it fail once
      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      const row = db.prepare('SELECT attempts FROM queue_items WHERE id = ?').get(item.id) as {
        attempts: number;
      };
      expect(row.attempts).toBeGreaterThanOrEqual(1);
    });

    it('handler throws (not returns err) → item is still marked failed', async () => {
      const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();

      manager.startProcessing(async () => {
        throw new Error('handler threw');
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(item.id) as {
        status: string;
      };
      expect(row.status).toBe('failed');
    });

    it('failed item with elapsed retry time is re-queued for processing', async () => {
      // Directly insert a failed item with next_retry_at in the past
      const failedId = uuidv4();
      const now = Date.now();
      db.prepare(`
        INSERT INTO queue_items
          (id, thread_id, message_id, type, status, attempts, max_attempts,
           next_retry_at, error, payload, claimed_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'message', 'failed', 1, 3, ?, 'prev error', '{}', NULL, ?, ?)
      `).run(failedId, threadId, now - 10000, now - 20000, now);

      const processed: string[] = [];
      manager.startProcessing(async (item) => {
        processed.push(item.id);
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      expect(processed).toContain(failedId);

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(failedId) as {
        status: string;
      };
      expect(row.status).toBe('completed');
    });
  });

  // -------------------------------------------------------------------------
  // Dead-letter
  // -------------------------------------------------------------------------

  describe('dead-letter: item exceeds max attempts → moved to DLQ', () => {
    it('dead-letters item after exhausting max attempts via repeated failures', async () => {
      // Configure with max 1 attempt so one failure → dead-letter
      const fastManager = new QueueManager(
        queueRepo,
        threadRepo,
        FAST_CONFIG,
        createTestLogger(),
      );

      const item = fastManager.enqueue(threadId, 'message', {})._unsafeUnwrap();

      fastManager.startProcessing(async () => err(new Error('always fails')));
      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      fastManager.stopProcessing();

      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(item.id) as {
        status: string;
      };
      expect(row.status).toBe('dead_letter');
    });

    it('dead-lettered items appear in findDeadLetter()', async () => {
      const fastManager = new QueueManager(
        queueRepo,
        threadRepo,
        FAST_CONFIG,
        createTestLogger(),
      );

      fastManager.enqueue(threadId, 'message', { cause: 'test-dlq' });

      fastManager.startProcessing(async () => err(new Error('always fails')));
      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      fastManager.stopProcessing();

      const dlqItems = queueRepo.findDeadLetter()._unsafeUnwrap();
      expect(dlqItems.length).toBeGreaterThanOrEqual(1);
    });

    it('stats reflect dead-letter count', async () => {
      const fastManager = new QueueManager(
        queueRepo,
        threadRepo,
        FAST_CONFIG,
        createTestLogger(),
      );

      fastManager.enqueue(threadId, 'message', {});

      fastManager.startProcessing(async () => err(new Error('always fails')));
      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      fastManager.stopProcessing();

      const stats = fastManager.stats();
      expect(stats.deadLetter).toBeGreaterThanOrEqual(1);
    });

    it('dead-letter item preserves the error message', async () => {
      const fastManager = new QueueManager(
        queueRepo,
        threadRepo,
        FAST_CONFIG,
        createTestLogger(),
      );

      const item = fastManager.enqueue(threadId, 'message', {})._unsafeUnwrap();
      const errorMessage = 'fatal processing error';

      fastManager.startProcessing(async () => err(new Error(errorMessage)));
      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      fastManager.stopProcessing();

      const row = db.prepare('SELECT error FROM queue_items WHERE id = ?').get(item.id) as {
        error: string | null;
      };
      expect(row.error).toBe(errorMessage);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent messages
  // -------------------------------------------------------------------------

  describe('concurrent messages: multiple items processed in FIFO per thread', () => {
    it('processes multiple items for the same thread in FIFO order', async () => {
      // Enqueue 3 items in order
      manager.enqueue(threadId, 'message', { order: 1 });
      manager.enqueue(threadId, 'message', { order: 2 });
      manager.enqueue(threadId, 'message', { order: 3 });

      const processedOrders: number[] = [];
      manager.startProcessing(async (item) => {
        processedOrders.push(Number(item.payload['order']));
        return ok(undefined);
      });

      // Wait enough for all 3 to process (each requires a poll cycle due to FIFO constraint)
      await new Promise((r) => setTimeout(r, 2000));
      manager.stopProcessing();

      expect(processedOrders).toHaveLength(3);
      expect(processedOrders).toEqual([1, 2, 3]);
    });

    it('multiple items from different threads are processed concurrently', async () => {
      const thread2 = seedThread(db);
      const thread3 = seedThread(db);

      manager.enqueue(threadId, 'message', { thread: 1 });
      manager.enqueue(thread2, 'message', { thread: 2 });
      manager.enqueue(thread3, 'message', { thread: 3 });

      const processedThreads: number[] = [];
      manager.startProcessing(async (item) => {
        processedThreads.push(Number(item.payload['thread']));
        // Small artificial delay
        await new Promise((r) => setTimeout(r, 20));
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      expect(processedThreads).toHaveLength(3);
      expect(processedThreads.sort()).toEqual([1, 2, 3]);
    });
  });

  // -------------------------------------------------------------------------
  // Thread isolation
  // -------------------------------------------------------------------------

  describe('thread isolation: items for different threads do not block each other', () => {
    it('a failing item in one thread does not block another thread', async () => {
      const thread2 = seedThread(db);

      // Thread 1 always fails
      manager.enqueue(threadId, 'message', { thread: 1 });
      // Thread 2 should succeed independently
      manager.enqueue(thread2, 'message', { thread: 2 });

      const successItems: number[] = [];
      manager.startProcessing(async (item) => {
        if (item.payload['thread'] === 1) {
          return err(new Error('thread 1 always fails'));
        }
        successItems.push(Number(item.payload['thread']));
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      expect(successItems).toContain(2);

      // Thread 2 item completed, thread 1 item failed
      const rows = db
        .prepare('SELECT thread_id, status FROM queue_items ORDER BY created_at')
        .all() as Array<{ thread_id: string; status: string }>;

      const thread2Row = rows.find((r) => r.thread_id === thread2);
      expect(thread2Row?.status).toBe('completed');
    });

    it('items with different threads do not interleave within a thread', async () => {
      const thread2 = seedThread(db);

      // 2 items per thread
      manager.enqueue(threadId, 'message', { thread: 1, seq: 'a' });
      manager.enqueue(threadId, 'message', { thread: 1, seq: 'b' });
      manager.enqueue(thread2, 'message', { thread: 2, seq: 'a' });
      manager.enqueue(thread2, 'message', { thread: 2, seq: 'b' });

      const log: Array<{ thread: number; seq: string }> = [];
      manager.startProcessing(async (item) => {
        log.push({ thread: Number(item.payload['thread']), seq: String(item.payload['seq']) });
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, 2500));
      manager.stopProcessing();

      // All 4 items should be processed
      expect(log).toHaveLength(4);

      // For thread 1: 'a' must come before 'b'
      const thread1Items = log.filter((l) => l.thread === 1);
      expect(thread1Items[0]?.seq).toBe('a');
      expect(thread1Items[1]?.seq).toBe('b');

      // For thread 2: 'a' must come before 'b'
      const thread2Items = log.filter((l) => l.thread === 2);
      expect(thread2Items[0]?.seq).toBe('a');
      expect(thread2Items[1]?.seq).toBe('b');
    });
  });

  // -------------------------------------------------------------------------
  // Mock connector integration
  // -------------------------------------------------------------------------

  describe('mock connector: outbound delivery', () => {
    it('connector send is called with correct thread and output', async () => {
      manager.enqueue(threadId, 'message', { content: 'ping' });

      manager.startProcessing(async (item) => {
        const output: AgentOutput = { body: 'pong' };
        await connector.send(item.threadId, output);
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      expect(connector.sentMessages).toHaveLength(1);
      expect(connector.sentMessages[0]?.threadId).toBe(threadId);
      expect(connector.sentMessages[0]?.output.body).toBe('pong');
    });

    it('connector format() is called for markdown conversion', () => {
      const markdown = '**bold** and _italic_';
      const formatted = connector.format(markdown);
      // Mock connector returns as-is
      expect(formatted).toBe(markdown);
    });

    it('connector returns ok result from send', async () => {
      const output: AgentOutput = { body: 'test message' };
      const result = await connector.send(threadId, output);
      expect(result.isOk()).toBe(true);
    });

    it('inbound simulation triggers registered handler', async () => {
      const receivedEvents: InboundEvent[] = [];
      connector.onMessage(async (event) => {
        receivedEvents.push(event);
      });

      const event: InboundEvent = {
        channelType: 'mock',
        channelName: 'test-connector',
        externalThreadId: 'ext-123',
        senderId: 'user-abc',
        idempotencyKey: 'key-001',
        content: 'hello from user',
        timestamp: Date.now(),
      };

      await connector.simulateInbound(event);

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]?.content).toBe('hello from user');
      expect(receivedEvents[0]?.idempotencyKey).toBe('key-001');
    });

    it('output with attachments is delivered correctly', async () => {
      manager.enqueue(threadId, 'message', {});

      const attachment = {
        filename: 'result.txt',
        mimeType: 'text/plain',
        data: Buffer.from('file content'),
        size: 12,
      };

      manager.startProcessing(async (item) => {
        const output: AgentOutput = {
          body: 'See attachment',
          attachments: [attachment],
        };
        await connector.send(item.threadId, output);
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      expect(connector.sentMessages[0]?.output.attachments).toHaveLength(1);
      expect(connector.sentMessages[0]?.output.attachments?.[0]?.filename).toBe('result.txt');
    });

    it('output with actions is delivered correctly', async () => {
      manager.enqueue(threadId, 'message', {});

      manager.startProcessing(async (item) => {
        const output: AgentOutput = {
          body: 'Please confirm',
          actions: [{ type: 'approval', label: 'Approve', value: 'yes' }],
        };
        await connector.send(item.threadId, output);
        return ok(undefined);
      });

      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      expect(connector.sentMessages[0]?.output.actions).toHaveLength(1);
      expect(connector.sentMessages[0]?.output.actions?.[0]?.type).toBe('approval');
    });
  });

  // -------------------------------------------------------------------------
  // Queue stats
  // -------------------------------------------------------------------------

  describe('queue stats reflect real-time state', () => {
    it('pending count is correct before processing', () => {
      manager.enqueue(threadId, 'message', {});
      manager.enqueue(threadId, 'message', {});
      manager.enqueue(threadId, 'message', {});

      const stats = manager.stats();
      expect(stats.pending).toBe(3);
    });

    it('stats transition to completed after processing', async () => {
      manager.enqueue(threadId, 'message', {});

      manager.startProcessing(async () => ok(undefined));
      await new Promise((r) => setTimeout(r, POLL_WAIT_MS));
      manager.stopProcessing();

      const stats = manager.stats();
      expect(stats.pending).toBe(0);
    });

    it('stats are zero for empty queue', () => {
      const stats = manager.stats();
      expect(stats).toEqual({ pending: 0, claimed: 0, processing: 0, deadLetter: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // Enqueue validation
  // -------------------------------------------------------------------------

  describe('enqueue validation', () => {
    it('returns error for non-existent thread', () => {
      const result = manager.enqueue(uuidv4(), 'message', {});
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Thread not found');
    });

    it('each enqueue produces a unique item id', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const item = manager.enqueue(threadId, 'message', {})._unsafeUnwrap();
        ids.add(item.id);
      }
      expect(ids.size).toBe(10);
    });

    it('enqueue stores payload as structured object', () => {
      const payload = { nested: { array: [1, 2, 3], str: 'hello' } };
      const item = manager.enqueue(threadId, 'message', payload)._unsafeUnwrap();
      expect(item.payload).toEqual(payload);
    });
  });
});

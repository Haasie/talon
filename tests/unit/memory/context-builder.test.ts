import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import pino from 'pino';

import { ContextBuilder } from '../../../src/memory/context-builder.js';
import { MemoryManager } from '../../../src/memory/memory-manager.js';
import { ThreadWorkspace } from '../../../src/memory/thread-workspace.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { MemoryRepository } from '../../../src/core/database/repositories/memory-repository.js';
import {
  createTestDb,
  uuid,
  makeTmpDir,
  seedThread,
  createMemoryManager,
  createSilentLogger,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContextBuilder(manager: MemoryManager): ContextBuilder {
  return new ContextBuilder(manager, createSilentLogger());
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ContextBuilder', () => {
  let db: Database.Database;
  let dataDir: string;
  let manager: MemoryManager;
  let builder: ContextBuilder;
  let threadId: string;
  let logger: pino.Logger;

  beforeEach(() => {
    db = createTestDb();
    dataDir = makeTmpDir();
    manager = createMemoryManager(db, dataDir);
    builder = makeContextBuilder(manager);
    logger = createSilentLogger();
    threadId = seedThread(db);
    new ThreadWorkspace(dataDir).ensureDirectories(threadId);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // buildContext — basic
  // -------------------------------------------------------------------------

  describe('buildContext()', () => {
    it('returns Ok with a ThreadContext', () => {
      const result = builder.buildContext(threadId, 'You are a helpful assistant.');
      expect(result.isOk()).toBe(true);
    });

    it('includes the persona system prompt verbatim', () => {
      const prompt = 'You are Alfred, a loyal butler.';
      const ctx = builder.buildContext(threadId, prompt)._unsafeUnwrap();
      expect(ctx.personaSystemPrompt).toBe(prompt);
    });

    it('returns empty transcript when no messages exist', () => {
      const ctx = builder.buildContext(threadId, 'prompt')._unsafeUnwrap();
      expect(ctx.transcript).toEqual([]);
    });

    it('returns empty notebookFiles when memory dir has no files', () => {
      const ctx = builder.buildContext(threadId, 'prompt')._unsafeUnwrap();
      expect(ctx.notebookFiles).toEqual({});
    });

    it('returns empty structuredMemory when no items exist', () => {
      const ctx = builder.buildContext(threadId, 'prompt')._unsafeUnwrap();
      expect(ctx.structuredMemory).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Transcript layer
  // -------------------------------------------------------------------------

  describe('transcript assembly', () => {
    function insertMessage(direction: 'inbound' | 'outbound', content: string): void {
      const msgRepo = new MessageRepository(db);
      msgRepo.insert({
        id: uuid(),
        thread_id: threadId,
        direction,
        content,
        idempotency_key: `k-${uuid()}`,
        provider_id: null,
        run_id: null,
      });
    }

    it('includes messages in transcript with correct shape', () => {
      insertMessage('inbound', 'hello');
      insertMessage('outbound', 'hi there');

      const ctx = builder.buildContext(threadId, 'prompt')._unsafeUnwrap();
      expect(ctx.transcript).toHaveLength(2);
      expect(ctx.transcript[0]).toMatchObject({ direction: 'inbound', content: 'hello' });
      expect(ctx.transcript[1]).toMatchObject({ direction: 'outbound', content: 'hi there' });
    });

    it('transcript entries have direction, content, and createdAt', () => {
      insertMessage('inbound', 'test');
      const entry = builder.buildContext(threadId, 'p')._unsafeUnwrap().transcript[0];
      expect(typeof entry.direction).toBe('string');
      expect(typeof entry.content).toBe('string');
      expect(typeof entry.createdAt).toBe('number');
    });

    it('respects workingMemoryLimit parameter', () => {
      for (let i = 0; i < 10; i++) {
        insertMessage('inbound', `msg ${i}`);
      }
      const ctx = builder.buildContext(threadId, 'prompt', 3)._unsafeUnwrap();
      expect(ctx.transcript).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Notebook layer
  // -------------------------------------------------------------------------

  describe('notebook layer', () => {
    it('includes notebook file contents', () => {
      manager.writeNotebook(threadId, 'CLAUDE.md', '# System notes');
      manager.writeNotebook(threadId, 'facts.md', '- Prefers coffee');

      const ctx = builder.buildContext(threadId, 'prompt')._unsafeUnwrap();
      expect(ctx.notebookFiles['CLAUDE.md']).toBe('# System notes');
      expect(ctx.notebookFiles['facts.md']).toBe('- Prefers coffee');
    });

    it('uses empty notebook when memory directory does not exist', () => {
      // Use a thread with no workspace on disk.
      const bareThreadId = seedThread(db);
      // Do NOT call ensureDirectories.
      const ctx = builder.buildContext(bareThreadId, 'prompt')._unsafeUnwrap();
      expect(ctx.notebookFiles).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Structured memory layer
  // -------------------------------------------------------------------------

  describe('structured memory layer', () => {
    it('includes facts and summaries', () => {
      manager.writeMemory({ threadId, type: 'fact', content: 'user likes tea', metadata: {} });
      manager.writeMemory({ threadId, type: 'summary', content: 'conv summary', metadata: {} });

      const ctx = builder.buildContext(threadId, 'prompt')._unsafeUnwrap();
      expect(ctx.structuredMemory).toHaveLength(2);
      const types = ctx.structuredMemory.map((i) => i.type);
      expect(types).toContain('fact');
      expect(types).toContain('summary');
    });

    it('structured memory items have the correct MemoryItem shape', () => {
      manager.writeMemory({
        threadId,
        type: 'note',
        content: 'remember this',
        metadata: { priority: 'high' },
      });

      const item = builder.buildContext(threadId, 'prompt')._unsafeUnwrap().structuredMemory[0];
      expect(item).toMatchObject({
        threadId,
        type: 'note',
        content: 'remember this',
        metadata: { priority: 'high' },
      });
      expect(typeof item.id).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // Full context assembly
  // -------------------------------------------------------------------------

  describe('full context assembly', () => {
    it('assembles all layers into a single ThreadContext', () => {
      const msgRepo = new MessageRepository(db);
      msgRepo.insert({
        id: uuid(),
        thread_id: threadId,
        direction: 'inbound',
        content: 'hello',
        idempotency_key: `k-${uuid()}`,
        provider_id: null,
        run_id: null,
      });

      manager.writeNotebook(threadId, 'CLAUDE.md', '# Notes');
      manager.writeMemory({ threadId, type: 'fact', content: 'fact', metadata: {} });

      const ctx = builder.buildContext(threadId, 'You are helpful.')._unsafeUnwrap();

      expect(ctx.transcript).toHaveLength(1);
      expect(ctx.notebookFiles['CLAUDE.md']).toBe('# Notes');
      expect(ctx.structuredMemory).toHaveLength(1);
      expect(ctx.personaSystemPrompt).toBe('You are helpful.');
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  describe('error propagation', () => {
    it('propagates structured memory read errors', () => {
      // Create a manager with a closed DB to force a DB error.
      const closedDb = createTestDb();
      const closedManager = createMemoryManager(closedDb, dataDir);
      const threadIdForTest = seedThread(closedDb);
      closedDb.close(); // close before query

      const errorBuilder = new ContextBuilder(closedManager, logger);
      const result = errorBuilder.buildContext(threadIdForTest, 'prompt');
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('MEMORY_ERROR');
    });

    it('propagates working memory read errors', () => {
      // Same pattern: close the DB to force failure at message read.
      const closedDb = createTestDb();
      const closedManager = createMemoryManager(closedDb, dataDir);
      const threadIdForTest = seedThread(closedDb);
      closedDb.close();

      const errorBuilder = new ContextBuilder(closedManager, logger);
      const result = errorBuilder.buildContext(threadIdForTest, 'prompt');
      expect(result.isErr()).toBe(true);
    });
  });
});

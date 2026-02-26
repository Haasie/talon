import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { MemoryManager } from '../../../src/memory/memory-manager.js';
import { ThreadWorkspace } from '../../../src/memory/thread-workspace.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import {
  createTestDb,
  uuid,
  makeTmpDir,
  seedThread,
  createMemoryManager,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MemoryManager', () => {
  let db: Database.Database;
  let dataDir: string;
  let manager: MemoryManager;
  let threadId: string;

  beforeEach(() => {
    db = createTestDb();
    dataDir = makeTmpDir();
    manager = createMemoryManager(db, dataDir);
    threadId = seedThread(db);
    // Create workspace directories so notebook operations have a real dir.
    new ThreadWorkspace(dataDir).ensureDirectories(threadId);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // readMemory
  // -------------------------------------------------------------------------

  describe('readMemory()', () => {
    it('returns empty array when no memory items exist', () => {
      const result = manager.readMemory(threadId);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it('returns all memory items for a thread', () => {
      manager.writeMemory({ threadId, type: 'fact', content: 'fact 1', metadata: {} });
      manager.writeMemory({ threadId, type: 'summary', content: 'summary 1', metadata: {} });
      manager.writeMemory({ threadId, type: 'note', content: 'note 1', metadata: {} });

      const result = manager.readMemory(threadId);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(3);
    });

    it('filters by type when specified', () => {
      manager.writeMemory({ threadId, type: 'fact', content: 'fact', metadata: {} });
      manager.writeMemory({ threadId, type: 'fact', content: 'fact 2', metadata: {} });
      manager.writeMemory({ threadId, type: 'summary', content: 'summary', metadata: {} });

      const facts = manager.readMemory(threadId, 'fact')._unsafeUnwrap();
      expect(facts).toHaveLength(2);
      expect(facts.every((f) => f.type === 'fact')).toBe(true);
    });

    it('maps DB rows to MemoryItem shape correctly', () => {
      manager.writeMemory({
        threadId,
        type: 'fact',
        content: 'user likes coffee',
        metadata: { source: 'run-123' },
      });

      const item = manager.readMemory(threadId)._unsafeUnwrap()[0];
      expect(item).toMatchObject({
        threadId,
        type: 'fact',
        content: 'user likes coffee',
        metadata: { source: 'run-123' },
      });
      expect(typeof item.id).toBe('string');
      expect(typeof item.createdAt).toBe('number');
      expect(typeof item.updatedAt).toBe('number');
    });

    it('returns empty array for unknown thread (no FK constraint on read)', () => {
      const result = manager.readMemory(uuid());
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // writeMemory
  // -------------------------------------------------------------------------

  describe('writeMemory()', () => {
    it('returns Ok with the persisted MemoryItem', () => {
      const result = manager.writeMemory({
        threadId,
        type: 'fact',
        content: 'test fact',
        metadata: {},
      });
      expect(result.isOk()).toBe(true);
      const item = result._unsafeUnwrap();
      expect(item.id).toBeDefined();
      expect(item.threadId).toBe(threadId);
      expect(item.type).toBe('fact');
      expect(item.content).toBe('test fact');
    });

    it('generates a unique id for each item', () => {
      const r1 = manager.writeMemory({ threadId, type: 'note', content: 'a', metadata: {} });
      const r2 = manager.writeMemory({ threadId, type: 'note', content: 'b', metadata: {} });
      expect(r1._unsafeUnwrap().id).not.toBe(r2._unsafeUnwrap().id);
    });

    it('preserves metadata as a plain object', () => {
      const meta = { run: 'r-1', tags: ['foo', 'bar'] };
      const result = manager.writeMemory({
        threadId,
        type: 'summary',
        content: 'x',
        metadata: meta as unknown as Record<string, unknown>,
      });
      expect(result._unsafeUnwrap().metadata).toEqual(meta);
    });

    it('returns Err when threadId does not exist (FK violation)', () => {
      const result = manager.writeMemory({
        threadId: uuid(),
        type: 'fact',
        content: 'orphan',
        metadata: {},
      });
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('MEMORY_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // getWorkingMemory
  // -------------------------------------------------------------------------

  describe('getWorkingMemory()', () => {
    function insertMessage(
      direction: 'inbound' | 'outbound',
      content: string,
    ): void {
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

    it('returns empty array when no messages exist', () => {
      const result = manager.getWorkingMemory(threadId);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it('returns messages with direction, content, and createdAt', () => {
      insertMessage('inbound', 'hello');
      insertMessage('outbound', 'hi there');

      const msgs = manager.getWorkingMemory(threadId)._unsafeUnwrap();
      expect(msgs).toHaveLength(2);
      expect(msgs[0]).toMatchObject({
        direction: 'inbound',
        content: 'hello',
      });
      expect(typeof msgs[0].createdAt).toBe('number');
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        insertMessage('inbound', `msg ${i}`);
      }
      const result = manager.getWorkingMemory(threadId, 5);
      expect(result._unsafeUnwrap()).toHaveLength(5);
    });

    it('uses default limit of 50', () => {
      for (let i = 0; i < 60; i++) {
        insertMessage('inbound', `msg ${i}`);
      }
      const result = manager.getWorkingMemory(threadId);
      expect(result._unsafeUnwrap()).toHaveLength(50);
    });

    it('returns empty array for unknown threadId (not an error)', () => {
      const result = manager.getWorkingMemory(uuid());
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // readNotebook
  // -------------------------------------------------------------------------

  describe('readNotebook()', () => {
    it('returns empty object when memory dir does not exist', () => {
      const altThreadId = uuid();
      // No ensureDirectories call — workspace does not exist.
      const workspace = new ThreadWorkspace(dataDir);
      const altManager = createMemoryManager(db, dataDir);
      // Override threadId to one without a directory.
      void workspace;
      const result = altManager.readNotebook(altThreadId);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({});
    });

    it('returns file contents keyed by filename', () => {
      manager.writeNotebook(threadId, 'CLAUDE.md', '# Notes\nHello world');
      manager.writeNotebook(threadId, 'facts.md', '- User likes coffee');

      const result = manager.readNotebook(threadId);
      expect(result.isOk()).toBe(true);
      const files = result._unsafeUnwrap();
      expect(files['CLAUDE.md']).toBe('# Notes\nHello world');
      expect(files['facts.md']).toBe('- User likes coffee');
    });

    it('skips subdirectories inside memory dir', () => {
      const memDir = new ThreadWorkspace(dataDir).getMemoryDir(threadId);
      fs.mkdirSync(path.join(memDir, 'subdir'));
      manager.writeNotebook(threadId, 'note.md', 'content');

      const files = manager.readNotebook(threadId)._unsafeUnwrap();
      expect(Object.keys(files)).toEqual(['note.md']);
    });
  });

  // -------------------------------------------------------------------------
  // writeNotebook
  // -------------------------------------------------------------------------

  describe('writeNotebook()', () => {
    it('creates and writes the notebook file', () => {
      const result = manager.writeNotebook(threadId, 'CLAUDE.md', '# Hello');
      expect(result.isOk()).toBe(true);

      const workspace = new ThreadWorkspace(dataDir);
      const content = fs.readFileSync(
        path.join(workspace.getMemoryDir(threadId), 'CLAUDE.md'),
        'utf8',
      );
      expect(content).toBe('# Hello');
    });

    it('overwrites existing file content', () => {
      manager.writeNotebook(threadId, 'notes.md', 'original');
      manager.writeNotebook(threadId, 'notes.md', 'updated');

      const files = manager.readNotebook(threadId)._unsafeUnwrap();
      expect(files['notes.md']).toBe('updated');
    });

    it('returns Err when filename contains path separators', () => {
      const result = manager.writeNotebook(threadId, '../escape.md', 'x');
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('MEMORY_ERROR');
    });

    it('ensures workspace directories are created if missing', () => {
      // Use a fresh thread that has no workspace yet.
      const freshThreadId = seedThread(db);
      // Do NOT call ensureDirectories — writeNotebook should handle it.
      const result = manager.writeNotebook(freshThreadId, 'auto.md', 'auto-created');
      expect(result.isOk()).toBe(true);
    });
  });
});

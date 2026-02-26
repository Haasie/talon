import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryRepository } from '../../../../../src/core/database/repositories/memory-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('MemoryRepository', () => {
  let db: Database.Database;
  let repo: MemoryRepository;
  let threadId: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new MemoryRepository(db);

    const channels = new ChannelRepository(db);
    const channelId = uuid();
    channels.insert({
      id: channelId,
      type: 'telegram',
      name: `ch-${uuid()}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    const threads = new ThreadRepository(db);
    threadId = uuid();
    threads.insert({
      id: threadId,
      channel_id: channelId,
      external_id: `ext-${uuid()}`,
      metadata: '{}',
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeItem(overrides: Partial<Parameters<MemoryRepository['insert']>[0]> = {}) {
    return {
      id: uuid(),
      thread_id: threadId,
      type: 'fact' as const,
      content: 'User likes coffee',
      embedding_ref: null,
      metadata: '{}',
      ...overrides,
    };
  }

  describe('insert', () => {
    it('inserts and returns the memory item', () => {
      const input = makeItem();
      const result = repo.insert(input);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().id).toBe(input.id);
    });

    it('returns err for non-existent thread_id (FK)', () => {
      expect(repo.insert(makeItem({ thread_id: uuid() })).isErr()).toBe(true);
    });
  });

  describe('findById', () => {
    it('finds by primary key', () => {
      const input = makeItem();
      repo.insert(input);
      expect(repo.findById(input.id)._unsafeUnwrap()?.id).toBe(input.id);
    });

    it('returns null for unknown id', () => {
      expect(repo.findById(uuid())._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findByThread', () => {
    it('returns all items for a thread', () => {
      repo.insert(makeItem({ type: 'fact' }));
      repo.insert(makeItem({ type: 'summary' }));
      repo.insert(makeItem({ type: 'note' }));
      expect(repo.findByThread(threadId)._unsafeUnwrap()).toHaveLength(3);
    });

    it('filters by type when specified', () => {
      repo.insert(makeItem({ type: 'fact' }));
      repo.insert(makeItem({ type: 'fact' }));
      repo.insert(makeItem({ type: 'summary' }));
      const facts = repo.findByThread(threadId, 'fact')._unsafeUnwrap();
      expect(facts).toHaveLength(2);
      expect(facts.every((f) => f.type === 'fact')).toBe(true);
    });

    it('returns empty array for unknown thread', () => {
      expect(repo.findByThread(uuid())._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('updates content and metadata', () => {
      const input = makeItem();
      repo.insert(input);
      const result = repo.update(input.id, { content: 'Updated fact', metadata: '{"key":"val"}' });
      const row = result._unsafeUnwrap();
      expect(row?.content).toBe('Updated fact');
      expect(row?.metadata).toBe('{"key":"val"}');
    });

    it('returns null for unknown id', () => {
      expect(repo.update(uuid(), { content: 'x' })._unsafeUnwrap()).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes the memory item', () => {
      const input = makeItem();
      repo.insert(input);
      repo.delete(input.id);
      expect(repo.findById(input.id)._unsafeUnwrap()).toBeNull();
    });

    it('is idempotent for unknown ids', () => {
      expect(repo.delete(uuid()).isOk()).toBe(true);
    });
  });
});

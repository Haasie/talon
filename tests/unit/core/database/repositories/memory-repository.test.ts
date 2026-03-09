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
  let threadId2: string;

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

    threadId2 = uuid();
    threads.insert({
      id: threadId2,
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

    it('allows same key in different threads', () => {
      const sharedKey = 'user_name';
      const r1 = repo.insert(makeItem({ id: sharedKey, thread_id: threadId, content: 'Alice' }));
      const r2 = repo.insert(makeItem({ id: sharedKey, thread_id: threadId2, content: 'Bob' }));
      expect(r1.isOk()).toBe(true);
      expect(r2.isOk()).toBe(true);
      expect(r1._unsafeUnwrap().content).toBe('Alice');
      expect(r2._unsafeUnwrap().content).toBe('Bob');
    });

    it('rejects duplicate key within same thread', () => {
      const key = 'user_name';
      repo.insert(makeItem({ id: key, thread_id: threadId }));
      const r2 = repo.insert(makeItem({ id: key, thread_id: threadId }));
      expect(r2.isErr()).toBe(true);
    });
  });

  describe('findById', () => {
    it('finds by compound key (threadId, id)', () => {
      const input = makeItem();
      repo.insert(input);
      expect(repo.findById(threadId, input.id)._unsafeUnwrap()?.id).toBe(input.id);
    });

    it('returns null for unknown id', () => {
      expect(repo.findById(threadId, uuid())._unsafeUnwrap()).toBeNull();
    });

    it('returns null when key exists in different thread', () => {
      const sharedKey = 'user_name';
      repo.insert(makeItem({ id: sharedKey, thread_id: threadId }));
      expect(repo.findById(threadId2, sharedKey)._unsafeUnwrap()).toBeNull();
    });

    it('finds correct item when same key exists in multiple threads', () => {
      const sharedKey = 'user_name';
      repo.insert(makeItem({ id: sharedKey, thread_id: threadId, content: 'Alice' }));
      repo.insert(makeItem({ id: sharedKey, thread_id: threadId2, content: 'Bob' }));

      const r1 = repo.findById(threadId, sharedKey)._unsafeUnwrap();
      const r2 = repo.findById(threadId2, sharedKey)._unsafeUnwrap();
      expect(r1?.content).toBe('Alice');
      expect(r2?.content).toBe('Bob');
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

    it('does not return items from other threads', () => {
      repo.insert(makeItem({ id: 'user_name', thread_id: threadId, content: 'Alice' }));
      repo.insert(makeItem({ id: 'user_name', thread_id: threadId2, content: 'Bob' }));

      const thread1Items = repo.findByThread(threadId)._unsafeUnwrap();
      expect(thread1Items).toHaveLength(1);
      expect(thread1Items[0].content).toBe('Alice');
    });
  });

  describe('update', () => {
    it('updates content and metadata', () => {
      const input = makeItem();
      repo.insert(input);
      const result = repo.update(threadId, input.id, { content: 'Updated fact', metadata: '{"key":"val"}' });
      const row = result._unsafeUnwrap();
      expect(row?.content).toBe('Updated fact');
      expect(row?.metadata).toBe('{"key":"val"}');
    });

    it('returns null for unknown id', () => {
      expect(repo.update(threadId, uuid(), { content: 'x' })._unsafeUnwrap()).toBeNull();
    });

    it('only updates item in the specified thread', () => {
      const sharedKey = 'user_name';
      repo.insert(makeItem({ id: sharedKey, thread_id: threadId, content: 'Alice' }));
      repo.insert(makeItem({ id: sharedKey, thread_id: threadId2, content: 'Bob' }));

      repo.update(threadId, sharedKey, { content: 'Alice Updated' });

      expect(repo.findById(threadId, sharedKey)._unsafeUnwrap()?.content).toBe('Alice Updated');
      expect(repo.findById(threadId2, sharedKey)._unsafeUnwrap()?.content).toBe('Bob');
    });
  });

  describe('delete', () => {
    it('removes the memory item', () => {
      const input = makeItem();
      repo.insert(input);
      repo.delete(threadId, input.id);
      expect(repo.findById(threadId, input.id)._unsafeUnwrap()).toBeNull();
    });

    it('is idempotent for unknown ids', () => {
      expect(repo.delete(threadId, uuid()).isOk()).toBe(true);
    });

    it('only deletes item in the specified thread', () => {
      const sharedKey = 'user_name';
      repo.insert(makeItem({ id: sharedKey, thread_id: threadId, content: 'Alice' }));
      repo.insert(makeItem({ id: sharedKey, thread_id: threadId2, content: 'Bob' }));

      repo.delete(threadId, sharedKey);

      expect(repo.findById(threadId, sharedKey)._unsafeUnwrap()).toBeNull();
      expect(repo.findById(threadId2, sharedKey)._unsafeUnwrap()?.content).toBe('Bob');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('ChannelRepository', () => {
  let db: Database.Database;
  let repo: ChannelRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new ChannelRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeChannel(overrides: Partial<Parameters<ChannelRepository['insert']>[0]> = {}) {
    return {
      id: uuid(),
      type: 'telegram',
      name: `channel-${uuid()}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
      ...overrides,
    };
  }

  describe('insert', () => {
    it('inserts and returns the new channel', () => {
      const input = makeChannel();
      const result = repo.insert(input);
      expect(result.isOk()).toBe(true);
      const row = result._unsafeUnwrap();
      expect(row.id).toBe(input.id);
      expect(row.name).toBe(input.name);
      expect(row.type).toBe('telegram');
      expect(row.created_at).toBeGreaterThan(0);
    });

    it('returns err on duplicate id', () => {
      const input = makeChannel();
      repo.insert(input);
      const result = repo.insert(input);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DB_ERROR');
    });

    it('returns err on duplicate name', () => {
      const name = `channel-${uuid()}`;
      repo.insert(makeChannel({ name }));
      const result = repo.insert(makeChannel({ name }));
      expect(result.isErr()).toBe(true);
    });
  });

  describe('findById', () => {
    it('returns the channel when it exists', () => {
      const input = makeChannel();
      repo.insert(input);
      const result = repo.findById(input.id);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()?.id).toBe(input.id);
    });

    it('returns null for a missing id', () => {
      const result = repo.findById(uuid());
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findByName', () => {
    it('returns the channel by unique name', () => {
      const input = makeChannel({ name: 'my-telegram' });
      repo.insert(input);
      const result = repo.findByName('my-telegram');
      expect(result._unsafeUnwrap()?.id).toBe(input.id);
    });

    it('returns null for an unknown name', () => {
      expect(repo.findByName('does-not-exist')._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findByType', () => {
    it('returns all channels of the given type', () => {
      repo.insert(makeChannel({ type: 'slack' }));
      repo.insert(makeChannel({ type: 'slack' }));
      repo.insert(makeChannel({ type: 'telegram' }));
      const result = repo.findByType('slack');
      expect(result._unsafeUnwrap()).toHaveLength(2);
    });

    it('returns empty array when no channels match', () => {
      expect(repo.findByType('discord')._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('findEnabled', () => {
    it('returns only enabled channels', () => {
      repo.insert(makeChannel({ enabled: 1 }));
      repo.insert(makeChannel({ enabled: 0 }));
      const result = repo.findEnabled();
      expect(result._unsafeUnwrap().every((c) => c.enabled === 1)).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('updates specified fields', () => {
      const input = makeChannel({ enabled: 1 });
      repo.insert(input);
      const result = repo.update(input.id, { enabled: 0, config: '{"foo":"bar"}' });
      expect(result.isOk()).toBe(true);
      const row = result._unsafeUnwrap();
      expect(row?.enabled).toBe(0);
      expect(row?.config).toBe('{"foo":"bar"}');
    });

    it('returns null for unknown id', () => {
      const result = repo.update(uuid(), { enabled: 0 });
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('returns existing row when no fields are provided', () => {
      const input = makeChannel();
      repo.insert(input);
      const result = repo.update(input.id, {});
      expect(result._unsafeUnwrap()?.id).toBe(input.id);
    });
  });

  describe('delete', () => {
    it('removes the channel', () => {
      const input = makeChannel();
      repo.insert(input);
      const del = repo.delete(input.id);
      expect(del.isOk()).toBe(true);
      expect(repo.findById(input.id)._unsafeUnwrap()).toBeNull();
    });

    it('is idempotent for unknown ids', () => {
      expect(repo.delete(uuid()).isOk()).toBe(true);
    });
  });
});

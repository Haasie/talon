import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AuditRepository } from '../../../../../src/core/database/repositories/audit-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('AuditRepository', () => {
  let db: Database.Database;
  let repo: AuditRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new AuditRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeEntry(overrides: Partial<Parameters<AuditRepository['insert']>[0]> = {}) {
    return {
      id: uuid(),
      run_id: null,
      thread_id: null,
      persona_id: null,
      action: 'tool.execute',
      tool: 'channel-send',
      request_id: uuid(),
      details: '{}',
      ...overrides,
    };
  }

  describe('insert', () => {
    it('inserts and returns the audit entry', () => {
      const input = makeEntry();
      const result = repo.insert(input);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().id).toBe(input.id);
      expect(result._unsafeUnwrap().action).toBe('tool.execute');
    });

    it('allows inserting multiple entries with the same action', () => {
      repo.insert(makeEntry({ action: 'channel.send' }));
      repo.insert(makeEntry({ action: 'channel.send' }));
      const rows = repo.findByAction('channel.send')._unsafeUnwrap();
      expect(rows).toHaveLength(2);
    });
  });

  describe('findByRun', () => {
    it('returns entries for a given run', () => {
      const runId = uuid();
      repo.insert(makeEntry({ run_id: runId }));
      repo.insert(makeEntry({ run_id: runId }));
      repo.insert(makeEntry({ run_id: uuid() }));
      const rows = repo.findByRun(runId)._unsafeUnwrap();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.run_id === runId)).toBe(true);
    });

    it('returns empty array for unknown run', () => {
      expect(repo.findByRun(uuid())._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('findByThread', () => {
    it('returns entries for a given thread', () => {
      const threadId = uuid();
      repo.insert(makeEntry({ thread_id: threadId }));
      repo.insert(makeEntry({ thread_id: threadId, action: 'channel.send' }));
      repo.insert(makeEntry({ thread_id: uuid() }));
      const rows = repo.findByThread(threadId)._unsafeUnwrap();
      expect(rows).toHaveLength(2);
    });
  });

  describe('findByAction', () => {
    it('returns entries matching the action', () => {
      repo.insert(makeEntry({ action: 'approval.grant' }));
      repo.insert(makeEntry({ action: 'approval.deny' }));
      repo.insert(makeEntry({ action: 'approval.grant' }));
      const rows = repo.findByAction('approval.grant')._unsafeUnwrap();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.action === 'approval.grant')).toBe(true);
    });

    it('filters by fromMs', () => {
      const before = Date.now() - 10_000;
      const after = Date.now();
      // Manually insert with specific timestamps.
      db.prepare(
        `INSERT INTO audit_log (id, run_id, thread_id, persona_id, action, tool, request_id, details, created_at)
         VALUES (?, NULL, NULL, NULL, 'test.action', NULL, NULL, '{}', ?)`,
      ).run(uuid(), before);
      db.prepare(
        `INSERT INTO audit_log (id, run_id, thread_id, persona_id, action, tool, request_id, details, created_at)
         VALUES (?, NULL, NULL, NULL, 'test.action', NULL, NULL, '{}', ?)`,
      ).run(uuid(), after);

      const rows = repo.findByAction('test.action', after - 1)._unsafeUnwrap();
      expect(rows).toHaveLength(1);
      expect(rows[0].created_at).toBeGreaterThanOrEqual(after - 1);
    });

    it('filters by toMs', () => {
      const cutoff = Date.now() - 5_000;
      db.prepare(
        `INSERT INTO audit_log (id, run_id, thread_id, persona_id, action, tool, request_id, details, created_at)
         VALUES (?, NULL, NULL, NULL, 'test.bounded', NULL, NULL, '{}', ?)`,
      ).run(uuid(), cutoff - 1000);
      db.prepare(
        `INSERT INTO audit_log (id, run_id, thread_id, persona_id, action, tool, request_id, details, created_at)
         VALUES (?, NULL, NULL, NULL, 'test.bounded', NULL, NULL, '{}', ?)`,
      ).run(uuid(), Date.now() + 10_000);

      const rows = repo.findByAction('test.bounded', undefined, cutoff)._unsafeUnwrap();
      expect(rows).toHaveLength(1);
    });

    it('returns empty array for unknown action', () => {
      expect(repo.findByAction('unknown.action')._unsafeUnwrap()).toHaveLength(0);
    });
  });
});

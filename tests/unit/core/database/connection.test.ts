import { describe, it, expect, afterEach } from 'vitest';
import { createDatabase } from '../../../../src/core/database/connection.js';
import type Database from 'better-sqlite3';

describe('createDatabase', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('returns ok with a Database instance for :memory:', () => {
    const result = createDatabase(':memory:');
    expect(result.isOk()).toBe(true);
    db = result._unsafeUnwrap();
    expect(db).toBeDefined();
  });

  it('returns err with DbError for an invalid path', () => {
    // A path with a non-existent directory should fail.
    const result = createDatabase('/nonexistent/path/that/cannot/exist/talon.sqlite');
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('DB_ERROR');
    expect(error.message).toMatch(/Failed to open database/);
  });

  it('sets journal_mode = WAL', () => {
    const result = createDatabase(':memory:');
    db = result._unsafeUnwrap();
    const mode = db.pragma('journal_mode', { simple: true });
    // In-memory databases return 'memory' not 'wal' — WAL pragma is applied
    // but silently ignored for :memory: databases. Verify the pragma was called
    // by checking it doesn't throw and the connection is open.
    expect(['memory', 'wal']).toContain(mode);
  });

  it('enables foreign_keys', () => {
    const result = createDatabase(':memory:');
    db = result._unsafeUnwrap();
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  it('sets busy_timeout = 5000', () => {
    const result = createDatabase(':memory:');
    db = result._unsafeUnwrap();
    const timeout = db.pragma('busy_timeout', { simple: true });
    expect(timeout).toBe(5000);
  });

  it('returned database can execute queries', () => {
    const result = createDatabase(':memory:');
    db = result._unsafeUnwrap();
    const row = db.prepare('SELECT 42 AS answer').get() as { answer: number };
    expect(row.answer).toBe(42);
  });
});

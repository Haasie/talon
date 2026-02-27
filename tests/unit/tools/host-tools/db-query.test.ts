/**
 * Unit tests for DbQueryHandler.
 *
 * Tests cover:
 *   - Successful SELECT query with column/row result shape
 *   - SQL safety check (reject INSERT, UPDATE, DELETE, DROP, etc.)
 *   - Non-SELECT statements rejected (must start with SELECT)
 *   - Comment-injection bypass attempts rejected
 *   - Missing/empty SQL rejected
 *   - Invalid params type rejected
 *   - Default limit of 100 rows
 *   - Custom limit, clamped to max 1000
 *   - Empty result set
 *   - Database execution errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DbQueryHandler } from '../../../../src/tools/host-tools/db-query.js';
import type { DbQueryArgs } from '../../../../src/tools/host-tools/db-query.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger;
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-001',
    threadId: 'thread-001',
    personaId: 'persona-001',
    requestId: 'req-001',
    ...overrides,
  };
}

function makeArgs(overrides: Partial<DbQueryArgs> = {}): DbQueryArgs {
  return {
    sql: 'SELECT id, name FROM personas',
    ...overrides,
  };
}

/** Create a mock Database.Statement that returns the given rows. */
function makeStatement(rows: Record<string, unknown>[]): Database.Statement {
  return {
    all: vi.fn().mockReturnValue(rows),
  } as unknown as Database.Statement;
}

/** Create a mock Database instance. */
function makeDb(statement?: Database.Statement): Database.Database {
  return {
    prepare: vi.fn().mockReturnValue(statement ?? makeStatement([])),
  } as unknown as Database.Database;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('DbQueryHandler — manifest', () => {
  it('has the correct tool name', () => {
    expect(DbQueryHandler.manifest.name).toBe('db.query');
  });

  it('has executionLocation set to host', () => {
    expect(DbQueryHandler.manifest.executionLocation).toBe('host');
  });

  it('declares db.read:own capability', () => {
    expect(DbQueryHandler.manifest.capabilities).toContain('db.read:own');
  });
});

// ---------------------------------------------------------------------------
// Successful queries
// ---------------------------------------------------------------------------

describe('DbQueryHandler — success', () => {
  it('returns columns, rows, and rowCount', async () => {
    const rows = [
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ];
    const db = makeDb(makeStatement(rows));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('success');
    expect(result.tool).toBe('db.query');
    expect(result.result).toEqual({
      columns: ['id', 'name'],
      rows: [['1', 'Alice'], ['2', 'Bob']],
      rowCount: 2,
    });
  });

  it('returns empty columns and rows for no results', async () => {
    const db = makeDb(makeStatement([]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('success');
    expect(result.result).toEqual({ columns: [], rows: [], rowCount: 0 });
  });

  it('wraps query in a LIMIT subquery with default limit of 100', async () => {
    const db = makeDb(makeStatement([]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    await handler.execute(makeArgs({ sql: 'SELECT * FROM threads' }), makeContext());

    expect(db.prepare).toHaveBeenCalledWith('SELECT * FROM (SELECT * FROM threads) LIMIT 100');
  });

  it('uses custom limit when provided', async () => {
    const db = makeDb(makeStatement([]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    await handler.execute(makeArgs({ sql: 'SELECT * FROM messages', limit: 25 }), makeContext());

    expect(db.prepare).toHaveBeenCalledWith('SELECT * FROM (SELECT * FROM messages) LIMIT 25');
  });

  it('clamps limit to MAX_LIMIT of 1000', async () => {
    const db = makeDb(makeStatement([]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    await handler.execute(makeArgs({ sql: 'SELECT * FROM messages', limit: 9999 }), makeContext());

    expect(db.prepare).toHaveBeenCalledWith('SELECT * FROM (SELECT * FROM messages) LIMIT 1000');
  });

  it('passes positional params to statement.all', async () => {
    const stmt = makeStatement([]);
    const db = makeDb(stmt);
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    await handler.execute(
      makeArgs({ sql: 'SELECT * FROM threads WHERE persona_id = ?', params: ['persona-001'] }),
      makeContext(),
    );

    expect(stmt.all).toHaveBeenCalledWith('persona-001');
  });

  it('handles null values in result rows', async () => {
    const rows = [{ id: '1', parent_id: null }];
    const db = makeDb(makeStatement(rows));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs(), makeContext());

    expect((result.result as { rows: unknown[][] }).rows[0][1]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SQL safety validation
// ---------------------------------------------------------------------------

describe('DbQueryHandler — SQL safety', () => {
  const forbiddenStatements = [
    { desc: 'INSERT', sql: 'INSERT INTO personas VALUES (1)' },
    { desc: 'UPDATE', sql: 'UPDATE personas SET name = "hacked"' },
    { desc: 'DELETE', sql: 'DELETE FROM personas WHERE 1=1' },
    { desc: 'DROP', sql: 'DROP TABLE personas' },
    { desc: 'CREATE', sql: 'CREATE TABLE evil (id TEXT)' },
    { desc: 'ALTER', sql: 'ALTER TABLE personas ADD COLUMN secret TEXT' },
    { desc: 'ATTACH', sql: 'ATTACH DATABASE "/etc/passwd" AS pw' },
    { desc: 'PRAGMA', sql: 'PRAGMA wal_checkpoint' },
    { desc: 'TRUNCATE', sql: 'TRUNCATE TABLE personas' },
    { desc: 'BEGIN', sql: 'BEGIN TRANSACTION' },
    { desc: 'COMMIT', sql: 'COMMIT' },
    { desc: 'ROLLBACK', sql: 'ROLLBACK' },
  ];

  for (const { desc, sql } of forbiddenStatements) {
    it(`rejects ${desc} statement`, async () => {
      const db = makeDb();
      const handler = new DbQueryHandler({ db, logger: makeLogger() });

      const result = await handler.execute(makeArgs({ sql }), makeContext());

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/only SELECT statements are allowed/i);
    });
  }

  it('rejects statement that does not start with SELECT', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ sql: 'WITH cte AS (SELECT 1) DELETE FROM t' }), makeContext());

    // This gets caught by the FORBIDDEN_KEYWORDS check on DELETE
    expect(result.status).toBe('error');
  });

  it('rejects block-comment injection to bypass safety check', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    // Block comment to hide the SELECT, real statement is DROP
    const result = await handler.execute(
      makeArgs({ sql: '/* SELECT * FROM t */ DROP TABLE t' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/only SELECT statements are allowed/i);
  });

  it('rejects line-comment injection to bypass safety check', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    // Line comment to hide DELETE
    const result = await handler.execute(
      makeArgs({ sql: '-- SELECT * FROM t\nDELETE FROM t' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/only SELECT statements are allowed/i);
  });

  it('accepts valid SELECT with leading whitespace', async () => {
    const db = makeDb(makeStatement([]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ sql: '   SELECT 1' }), makeContext());

    expect(result.status).toBe('success');
  });

  it('accepts case-insensitive select', async () => {
    const db = makeDb(makeStatement([]));
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ sql: 'select * from threads' }), makeContext());

    expect(result.status).toBe('success');
  });

  it('rejects non-SELECT non-DML statement (bare identifier)', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ sql: 'EXPLAIN SELECT 1' }), makeContext());

    // EXPLAIN is not in forbidden keywords but does not start with SELECT
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/must begin with SELECT/);
  });
});

// ---------------------------------------------------------------------------
// Arg validation failures
// ---------------------------------------------------------------------------

describe('DbQueryHandler — arg validation', () => {
  it('returns error when sql is empty', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ sql: '' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/sql is required/);
  });

  it('returns error when sql is whitespace only', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ sql: '   ' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/sql is required/);
  });

  it('returns error when params is not an array', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ sql: 'SELECT 1', params: 'not-an-array' as unknown as unknown[] }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/params must be an array/);
  });
});

// ---------------------------------------------------------------------------
// Database execution errors
// ---------------------------------------------------------------------------

describe('DbQueryHandler — database errors', () => {
  it('returns error when prepare throws', async () => {
    const db = {
      prepare: vi.fn().mockImplementation(() => {
        throw new Error('syntax error near "FROM"');
      }),
    } as unknown as Database.Database;
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ sql: 'SELECT * FROM nonexistent' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/query execution failed/);
    expect(result.error).toMatch(/syntax error/);
  });

  it('returns error when statement.all throws', async () => {
    const stmt = {
      all: vi.fn().mockImplementation(() => {
        throw new Error('table not found');
      }),
    } as unknown as Database.Statement;
    const db = makeDb(stmt);
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ sql: 'SELECT * FROM missing' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/query execution failed/);
  });

  it('uses unknown requestId when not in context', async () => {
    const db = makeDb();
    const handler = new DbQueryHandler({ db, logger: makeLogger() });

    const context = makeContext();
    delete (context as Partial<ToolExecutionContext>).requestId;
    // Empty SQL triggers validation before any DB call
    const result = await handler.execute(makeArgs({ sql: '' }), context);

    expect(result.requestId).toBe('unknown');
  });
});

/**
 * Unit tests for MemoryAccessHandler.
 *
 * Tests cover:
 *   - All 4 operations: read, write, delete, list
 *   - Arg validation failures (missing key, missing value, invalid operation)
 *   - Repository error propagation
 *   - Namespace/type mapping
 *   - Write upsert behaviour (insert vs. update)
 *   - List filtering by namespace
 *
 * Thread isolation is enforced at the schema level (compound PK) and tested
 * in the repository integration tests rather than here.
 */

import { describe, it, expect, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import { MemoryAccessHandler } from '../../../../src/tools/host-tools/memory-access.js';
import type { MemoryAccessArgs } from '../../../../src/tools/host-tools/memory-access.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import { DbError } from '../../../../src/core/errors/error-types.js';
import type { MemoryRepository, MemoryItemRow } from '../../../../src/core/database/repositories/memory-repository.js';

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

function makeArgs(overrides: Partial<MemoryAccessArgs> = {}): MemoryAccessArgs {
  return {
    operation: 'read',
    key: 'my-key',
    ...overrides,
  };
}

function makeMemoryRow(overrides: Partial<MemoryItemRow> = {}): MemoryItemRow {
  return {
    id: 'my-key',
    thread_id: 'thread-001',
    type: 'note',
    content: 'Hello memory!',
    embedding_ref: null,
    metadata: '{}',
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<MemoryRepository> = {}): MemoryRepository {
  return {
    findById: vi.fn().mockReturnValue(ok(null)),
    findByThread: vi.fn().mockReturnValue(ok([])),
    insert: vi.fn().mockReturnValue(ok(makeMemoryRow())),
    update: vi.fn().mockReturnValue(ok(makeMemoryRow())),
    delete: vi.fn().mockReturnValue(ok(undefined)),
    ...overrides,
  } as unknown as MemoryRepository;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('MemoryAccessHandler — manifest', () => {
  it('has the correct tool name', () => {
    expect(MemoryAccessHandler.manifest.name).toBe('memory.access');
  });

  it('has executionLocation set to host', () => {
    expect(MemoryAccessHandler.manifest.executionLocation).toBe('host');
  });

  it('declares both read and write capabilities', () => {
    expect(MemoryAccessHandler.manifest.capabilities).toContain('memory.read:thread');
    expect(MemoryAccessHandler.manifest.capabilities).toContain('memory.write:thread');
  });
});

// ---------------------------------------------------------------------------
// Operation: read
// ---------------------------------------------------------------------------

describe('MemoryAccessHandler — read', () => {
  it('returns the memory item when found', async () => {
    const row = makeMemoryRow({ content: 'stored value' });
    const repo = makeRepo({ findById: vi.fn().mockReturnValue(ok(row)) });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ operation: 'read', key: 'my-key' }), makeContext());

    expect(result.status).toBe('success');
    expect(result.result).toEqual({
      key: 'my-key',
      value: 'stored value',
      namespace: 'note',
      metadata: '{}',
    });
  });

  it('passes threadId and key to findById', async () => {
    const findById = vi.fn().mockReturnValue(ok(null));
    const repo = makeRepo({ findById });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    await handler.execute(makeArgs({ operation: 'read', key: 'my-key' }), makeContext({ threadId: 'thread-xyz' }));

    expect(findById).toHaveBeenCalledWith('thread-xyz', 'my-key');
  });

  it('returns null result when key is not found', async () => {
    const repo = makeRepo({ findById: vi.fn().mockReturnValue(ok(null)) });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ operation: 'read', key: 'missing' }), makeContext());

    expect(result.status).toBe('success');
    expect(result.result).toBeNull();
  });

  it('returns error when key is missing', async () => {
    const repo = makeRepo();
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ operation: 'read', key: undefined }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/key is required/);
  });

  it('returns error when key is empty string', async () => {
    const repo = makeRepo();
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ operation: 'read', key: '' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/key is required/);
  });

  it('propagates repository errors', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockReturnValue(err(new DbError('disk full'))),
    });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ operation: 'read' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/read failed/);
  });
});

// ---------------------------------------------------------------------------
// Operation: write
// ---------------------------------------------------------------------------

describe('MemoryAccessHandler — write', () => {
  it('inserts a new item when key does not exist', async () => {
    const insertFn = vi.fn().mockReturnValue(ok(makeMemoryRow()));
    const repo = makeRepo({
      findById: vi.fn().mockReturnValue(ok(null)),
      insert: insertFn,
    });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ operation: 'write', key: 'new-key', value: 'hello' }),
      makeContext(),
    );

    expect(result.status).toBe('success');
    expect(result.result).toEqual({ key: 'new-key', written: true });
    expect(insertFn).toHaveBeenCalled();
  });

  it('updates an existing item when key already exists in same thread', async () => {
    const updateFn = vi.fn().mockReturnValue(ok(makeMemoryRow()));
    const repo = makeRepo({
      findById: vi.fn().mockReturnValue(ok(makeMemoryRow({ id: 'existing-key' }))),
      update: updateFn,
    });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ operation: 'write', key: 'existing-key', value: 'updated value' }),
      makeContext(),
    );

    expect(result.status).toBe('success');
    expect(updateFn).toHaveBeenCalledWith('thread-001', 'existing-key', { content: 'updated value' });
  });

  it('passes threadId to findById for write pre-check', async () => {
    const findById = vi.fn().mockReturnValue(ok(null));
    const repo = makeRepo({ findById, insert: vi.fn().mockReturnValue(ok(makeMemoryRow())) });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    await handler.execute(
      makeArgs({ operation: 'write', key: 'k', value: 'v' }),
      makeContext({ threadId: 'thread-xyz' }),
    );

    expect(findById).toHaveBeenCalledWith('thread-xyz', 'k');
  });

  it('generates a key when none is provided', async () => {
    const insertFn = vi.fn().mockReturnValue(ok(makeMemoryRow()));
    const repo = makeRepo({
      findById: vi.fn().mockReturnValue(ok(null)),
      insert: insertFn,
    });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ operation: 'write', key: undefined, value: 'auto-keyed' }),
      makeContext(),
    );

    expect(result.status).toBe('success');
    // Key is auto-generated UUID, not the original undefined
    expect((result.result as { key: string }).key).toBeTruthy();
  });

  it('returns error when value is missing', async () => {
    const repo = makeRepo();
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ operation: 'write', value: undefined }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/value is required/);
  });

  it('serializes non-string values to JSON', async () => {
    const insertFn = vi.fn().mockReturnValue(ok(makeMemoryRow()));
    const repo = makeRepo({
      findById: vi.fn().mockReturnValue(ok(null)),
      insert: insertFn,
    });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    await handler.execute(
      makeArgs({ operation: 'write', key: 'obj-key', value: { nested: true, count: 42 } }),
      makeContext(),
    );

    const callArgs = insertFn.mock.calls[0][0];
    expect(callArgs.content).toBe(JSON.stringify({ nested: true, count: 42 }));
  });

  it('maps "fact" namespace to fact type', async () => {
    const insertFn = vi.fn().mockReturnValue(ok(makeMemoryRow()));
    const repo = makeRepo({
      findById: vi.fn().mockReturnValue(ok(null)),
      insert: insertFn,
    });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    await handler.execute(
      makeArgs({ operation: 'write', key: 'fact-key', value: 'a fact', namespace: 'fact' }),
      makeContext(),
    );

    expect(insertFn.mock.calls[0][0].type).toBe('fact');
  });

  it('maps unknown namespace to note type', async () => {
    const insertFn = vi.fn().mockReturnValue(ok(makeMemoryRow()));
    const repo = makeRepo({
      findById: vi.fn().mockReturnValue(ok(null)),
      insert: insertFn,
    });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    await handler.execute(
      makeArgs({ operation: 'write', key: 'key', value: 'val', namespace: 'random-thing' }),
      makeContext(),
    );

    expect(insertFn.mock.calls[0][0].type).toBe('note');
  });

  it('propagates insert errors', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockReturnValue(ok(null)),
      insert: vi.fn().mockReturnValue(err(new DbError('constraint violation'))),
    });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ operation: 'write', key: 'k', value: 'v' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/write \(insert\) failed/);
  });
});

// ---------------------------------------------------------------------------
// Operation: delete
// ---------------------------------------------------------------------------

describe('MemoryAccessHandler — delete', () => {
  it('deletes an existing item successfully', async () => {
    const deleteFn = vi.fn().mockReturnValue(ok(undefined));
    const repo = makeRepo({ delete: deleteFn });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ operation: 'delete', key: 'my-key' }),
      makeContext(),
    );

    expect(result.status).toBe('success');
    expect(result.result).toEqual({ key: 'my-key', deleted: true });
    expect(deleteFn).toHaveBeenCalledWith('thread-001', 'my-key');
  });

  it('returns error when key is missing', async () => {
    const repo = makeRepo();
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ operation: 'delete', key: undefined }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/key is required/);
  });

  it('propagates delete errors', async () => {
    const repo = makeRepo({
      delete: vi.fn().mockReturnValue(err(new DbError('io error'))),
    });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ operation: 'delete', key: 'my-key' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/delete failed/);
  });
});

// ---------------------------------------------------------------------------
// Operation: list
// ---------------------------------------------------------------------------

describe('MemoryAccessHandler — list', () => {
  it('lists all items for the thread', async () => {
    const rows = [
      makeMemoryRow({ id: 'k1', content: 'v1' }),
      makeMemoryRow({ id: 'k2', content: 'v2', type: 'fact' }),
    ];
    const repo = makeRepo({ findByThread: vi.fn().mockReturnValue(ok(rows)) });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ operation: 'list' }), makeContext());

    expect(result.status).toBe('success');
    expect((result.result as { count: number }).count).toBe(2);
    expect((result.result as { items: unknown[] }).items).toHaveLength(2);
  });

  it('filters by namespace when provided', async () => {
    const repo = makeRepo({ findByThread: vi.fn().mockReturnValue(ok([])) });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    await handler.execute(makeArgs({ operation: 'list', namespace: 'fact' }), makeContext({ threadId: 'thread-001' }));

    expect(repo.findByThread).toHaveBeenCalledWith('thread-001', 'fact');
  });

  it('lists without namespace filter when namespace is not provided', async () => {
    const repo = makeRepo({ findByThread: vi.fn().mockReturnValue(ok([])) });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    await handler.execute(makeArgs({ operation: 'list', namespace: undefined }), makeContext({ threadId: 'thread-001' }));

    expect(repo.findByThread).toHaveBeenCalledWith('thread-001', undefined);
  });

  it('propagates list errors', async () => {
    const repo = makeRepo({
      findByThread: vi.fn().mockReturnValue(err(new DbError('query failed'))),
    });
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(makeArgs({ operation: 'list' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/list failed/);
  });
});

// ---------------------------------------------------------------------------
// Invalid operation
// ---------------------------------------------------------------------------

describe('MemoryAccessHandler — invalid operation', () => {
  it('returns error for an unknown operation', async () => {
    const repo = makeRepo();
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      makeArgs({ operation: 'purge' as MemoryAccessArgs['operation'] }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/invalid operation/);
  });

  it('returns error for missing operation', async () => {
    const repo = makeRepo();
    const handler = new MemoryAccessHandler({ memoryRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { operation: undefined as unknown as MemoryAccessArgs['operation'] },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/invalid operation/);
  });
});
